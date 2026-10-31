import { ModelMessageItem } from '@mozaik-ai/core';
import { codedError } from './domain.mjs';
import { parseRoleOutput } from './transport-protocol.mjs';

/** Guarded transport adapter for the same three Mozaik Agents and event handlers. */
export function createProviderInferenceRunner({ budget, provider, beforeDispatch, mode = 'OFFLINE_TRANSPORT' }) {
  return {
    async run(request) {
      if (request.model !== 'planpatch-guarded-provider' || request.tools?.length || request.streaming)
        throw codedError('TRANSPORT_REQUEST_REJECTED');
      const items = request.context.getItems().filter(item => item.type === 'message');
      const task = JSON.parse(items.filter(item => item.role === 'user').at(-1)?.content.text ?? '{}');
      const messages = items.map(item => ({ role: item.role === 'developer' ? 'system' : item.role, content: item.content.text }));
      // Synchronous final gate: no await between revision/price/deadline validation
      // and provider.begin/native fetch. A failed gate durably stops every agent.
      try { beforeDispatch?.(); } catch (error) { budget.stop(); throw error; }
      const response = await provider.generate({ ...request.planpatch, messages });
      let output;
      try { output = parseRoleOutput(response.content, task); }
      catch {
        // The successful HTTP reservation stays consumed. Halt before any promise
        // continuation can dispatch C, reserve a recheck, or publish another result.
        budget.haltForInvalidOutput();
        throw codedError('INVALID_AGENT_OUTPUT');
      }
      return { items: [ModelMessageItem.rehydrate({ text: JSON.stringify(output) })], tokenUsage: undefined,
        rowResponse: { mode, synthetic: true } };
    },
    async *stream() { throw codedError('TRANSPORT_STREAMING_DISABLED'); },
  };
}
