import { ModelMessageItem } from '@mozaik-ai/core';
import { codedError, extractEvidence, evidenceFindings, proposeRevision, evaluateChecks } from './domain.mjs';

/** Deterministic local inference, injected into the same Mozaik runtime used for agent tasks. */
export function createMockInferenceRunner({ delays = { facts: 70, review: 650, owner: 80, recheck: 30 } } = {}) {
  return {
    async run(request) {
      if (request.model !== 'planpatch-deterministic-mock' || request.tools?.length || request.streaming) throw codedError('MOCK_REQUEST_REJECTED');
      const messages = request.context.getItems().filter(item => item.type === 'message' && item.role === 'user');
      const payload = JSON.parse(messages.at(-1)?.content.text ?? '{}');
      const { agentId, kind, snapshot, requirements } = payload;
      if (!snapshot || !({ facts: 'A', review: 'B', recheck: 'B', owner: 'C' }[kind] === agentId)) throw codedError('INVALID_MOCK_TASK');
      await new Promise(resolve => setTimeout(resolve, Math.max(0, delays[kind] ?? 0)));
      let output;
      if (kind === 'facts') {
        const evidence = extractEvidence(snapshot.sources);
        output = { baseProposalVersion: snapshot.proposalVersion, baseEvidenceVersion: snapshot.evidenceVersion,
          evidence, findings: evidenceFindings(evidence, snapshot.proposal) };
      } else if (kind === 'owner') output = proposeRevision(snapshot);
      else output = evaluateChecks(snapshot, requirements);
      return { items: [ModelMessageItem.rehydrate({ text: JSON.stringify(output) })], tokenUsage: undefined,
        rowResponse: { mode: 'MOCK', synthetic: true } };
    },
    async *stream() { throw codedError('MOCK_STREAMING_DISABLED'); },
  };
}
