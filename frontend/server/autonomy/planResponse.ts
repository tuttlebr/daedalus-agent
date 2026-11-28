import { PlanningFailure } from './planErrors';

/** Fold the planning model's Chat SSE into the final, tool-free draft.
 * JSON remains readable while an older backend is being replaced.
 */
export function parsePlanResponse(raw: string, streaming: boolean) {
  if (!streaming) return JSON.parse(raw);
  let content = '';
  let refusal = '';
  let finish: string | null = null;
  let done = false;
  let tools = false;
  for (const frame of raw.replace(/\r\n/g, '\n').split('\n\n')) {
    const lines = frame.split('\n');
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    if (done) throw new PlanningFailure('invalid_response');
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    const event = JSON.parse(data);
    if (event.error || event.type === 'error')
      throw new PlanningFailure('invalid_response');
    if (!Array.isArray(event.choices)) {
      // Dynamo emits a separate reasoning_dispatch before the answer. Switchyard
      // forwards its payload without the SSE name and adds the selected model.
      const name = lines
        .findLast((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim();
      if (
        (!name || name === 'reasoning_dispatch' || name === 'message') &&
        event.index === 0 &&
        typeof event.reasoning_content === 'string' &&
        (event.model === undefined || typeof event.model === 'string') &&
        Object.keys(event).every((key) =>
          ['index', 'reasoning_content', 'model'].includes(key),
        )
      )
        continue;
      throw new PlanningFailure('invalid_response');
    }
    for (const choice of event.choices) {
      if (choice.index !== undefined && choice.index !== 0)
        throw new PlanningFailure('invalid_response');
      const delta = choice.delta;
      if (!delta || typeof delta !== 'object')
        throw new PlanningFailure('invalid_response');
      if (
        finish &&
        (delta.content || delta.refusal || delta.tool_calls?.length)
      )
        throw new PlanningFailure('invalid_response');
      for (const key of ['content', 'refusal']) {
        if (delta[key] != null && typeof delta[key] !== 'string')
          throw new PlanningFailure('invalid_response');
      }
      content += delta.content || '';
      refusal += delta.refusal || '';
      tools ||= Boolean(delta.tool_calls?.length);
      if (Buffer.byteLength(content + refusal, 'utf8') > 64 * 1024)
        throw new PlanningFailure('oversized_response');
      if (choice.finish_reason != null) {
        if (
          typeof choice.finish_reason !== 'string' ||
          (finish !== null && finish !== choice.finish_reason)
        )
          throw new PlanningFailure('invalid_response');
        finish = choice.finish_reason;
      }
    }
  }
  if (!done || !finish) throw new PlanningFailure('incomplete_response');
  return {
    choices: [
      {
        finish_reason: finish,
        message: { content, refusal, tool_calls: tools ? [{}] : [] },
      },
    ],
  };
}
