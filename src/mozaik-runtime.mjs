import { Agent, defineRuntime, RuntimeState, SemanticEvent, SituationSpecification, ModelContext,
  DeveloperMessageItem, UserMessageItem } from '@mozaik-ai/core';
import { randomUUID } from 'node:crypto';
import { clone, codedError } from './domain.mjs';
import { ROLES, safetyInstruction } from './prompts.mjs';

class TaskForAgent extends SituationSpecification {
  constructor(id) { super(); this.id = id; }
  isSatisfiedBy({ event }) { return event.type === 'planpatch.task' && event.payload.agentId === this.id; }
}
class PlanPatchRuntimeState extends RuntimeState {}

/**
 * Real Mozaik Agents, runtime dispatch and situation handlers; a deliberately explicit loop.
 * Pinned core 4.0.0-beta.8 uses ModelContext.addItem. RuntimeService with an injected
 * runner and our handlers provides explicit dispatch without a Cloud client or runLoop helper.
 * A funded runner uses this same role/event machinery only via the trusted entry capability.
 */
export function createMozaikRuntime({ runner, onSignal = () => {}, model = 'planpatch-deterministic-mock', mode = 'MOCK' }) {
  if (!runner || typeof runner.run !== 'function') throw codedError('RUNNER_REQUIRED');
  const definition = defineRuntime();
  const runtime = definition.initializeRuntime({ state: new PlanPatchRuntimeState(), inferenceRunnerConfig: { runner } });
  const pending = new Map(), activeAgents = new Set();
  let closed = false;
  const agents = {};
  for (const [id, role] of Object.entries(ROLES)) {
    const agent = Agent.create({ name: `${id} ${role.name}`, instruction: `${role.instruction}\n${safetyInstruction(mode)}`,
      tools: [], capabilities: [`planpatch.${id}`], handlers: [{ specification: new TaskForAgent(id), processor: {
        apply({ event, participant }) {
          const { requestId, task } = event.payload;
          const entry = pending.get(requestId);
          if (!entry) return;
          // Runtime's EventProcessor intentionally doesn't await handlers. Capture every rejection.
          const execute = async () => {
            onSignal({ type: 'AGENT_STARTED', agentId: id, requestId, kind: task.kind,
              mozaikParticipantId: participant.getId(), baseProposalVersion: task.snapshot.proposalVersion,
              baseEvidenceVersion: task.snapshot.evidenceVersion });
            const context = ModelContext.create();
            context.addItem(DeveloperMessageItem.create(participant.getDeveloperMessage()));
            context.addItem(UserMessageItem.create(JSON.stringify(task)));
            let output;
            try {
              output = await runtime.getInferenceRunner().run({ model, context,
                tools: participant.getTools(), streaming: false, planpatch: entry.execution });
            } catch (error) {
              onSignal({ type: closed ? 'LATE_RESULT_DISCARDED' : 'AGENT_FAILED', agentId: id, requestId, kind: task.kind });
              throw error;
            }
            const message = output.items.find(item => item.type === 'message' && item.role === 'assistant');
            if (!message) throw codedError('AGENT_OUTPUT_MISSING');
            const parsed = JSON.parse(message.content.text);
            onSignal({ type: closed ? 'LATE_RESULT_DISCARDED' : 'AGENT_COMPLETED', agentId: id, requestId, kind: task.kind });
            if (closed) throw codedError('RUN_STOPPED');
            // Publish through the actual RuntimeService; no late result is published after stop.
            runtime.publish(SemanticEvent.create('planpatch.result', participant.getId(), { requestId, agentId: id }));
            return parsed;
          };
          const finish = (callback, value) => { pending.delete(requestId); activeAgents.delete(id); callback(value); };
          execute().then(value => finish(entry.resolve, value), error => finish(entry.reject, error));
        },
      } }] });
    agents[id] = agent;
    definition.join(agent);
  }
  return {
    identities: Object.entries(agents).map(([id, agent]) => ({ id, name: ROLES[id].name, mozaikParticipantId: agent.getId() })),
    dispatch(agentId, task, execution = {}) {
      if (closed) return Promise.reject(codedError('RUN_STOPPED'));
      if (!agents[agentId] || task.agentId !== agentId) return Promise.reject(codedError('INVALID_AGENT'));
      if (activeAgents.size >= 3 || activeAgents.has(agentId)) return Promise.reject(codedError('AGENT_BUSY'));
      activeAgents.add(agentId);
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        pending.set(requestId, { resolve, reject, execution });
        runtime.publish(SemanticEvent.create('planpatch.task', 'planpatch-coordinator', { requestId, agentId, task: clone(task) }));
      });
    },
    close() { closed = true; },
    get activeCount() { return activeAgents.size; },
  };
}
