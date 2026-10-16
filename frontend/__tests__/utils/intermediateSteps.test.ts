import {
  consolidateSteps,
  flattenSteps,
  getOutcomeSummary,
} from '@/utils/app/intermediateSteps';

import {
  IntermediateStep,
  IntermediateStepType as Type,
} from '@/types/intermediateSteps';

import { describe, expect, it } from 'vitest';

function event(
  type: Type,
  id: string,
  timestamp: number,
  data?: any,
): IntermediateStep {
  return {
    parent_id: 'root',
    function_ancestry: {
      node_id: id,
      parent_id: null,
      function_name: 'search',
      depth: 0,
    },
    payload: {
      event_type: type,
      UUID: id,
      name: 'search',
      event_timestamp: timestamp,
      data,
    },
  };
}

describe('activity operation consolidation', () => {
  it('preserves identity and start arguments when a tool result arrives', () => {
    const start = event(Type.TOOL_START, 'start', 10, {
      input: { query: 'deployment' },
    });
    const end = event(Type.TOOL_END, 'end', 12, { output: false });
    const [active] = consolidateSteps([start]);
    const [completed] = consolidateSteps([start, end], true);
    expect(active.id).toBe(completed.id);
    expect(completed.input).toEqual({ query: 'deployment' });
    expect(completed.output).toBe(false);
    expect(completed.duration).toBe(2000);
    expect(completed.status).toBe('completed');
  });

  it('pairs concurrent calls to the same tool using their span timestamps', () => {
    const first = event(Type.TOOL_START, 'first', 10);
    const second = event(Type.TOOL_START, 'second', 11);
    const secondEnd = event(Type.TOOL_END, 'second-end', 12, {
      output: 'second result',
    });
    secondEnd.payload.span_event_timestamp = 11;
    const [stillRunning, completed] = consolidateSteps([
      first,
      second,
      secondEnd,
    ]);
    expect(stillRunning.status).toBe('active');
    expect(completed.id).toBe('second');
    expect(completed.output).toBe('second result');
    expect(completed.duration).toBe(1000);
  });

  it.each([
    { isError: true, content: 'service unavailable' },
    { status: 'error', content: 'service unavailable' },
    JSON.stringify({ status: 'failed', error: 'service unavailable' }),
    'Tool failed (TimeoutError). Check service availability.',
  ])('retains failed tool outcomes (%j)', (output) => {
    expect(
      consolidateSteps([event(Type.TOOL_END, 'end', 12, { output })], true)[0]
        .status,
    ).toBe('failed');
  });

  it('marks missing terminal events interrupted without changing confirmed successes', () => {
    const steps = [
      event(Type.TOOL_START, 'start', 10),
      {
        ...event(Type.TOOL_END, 'other', 12),
        payload: {
          ...event(Type.TOOL_END, 'other', 12).payload,
          name: 'other-tool',
        },
      },
    ];
    expect(
      flattenSteps(consolidateSteps(steps, true)).map((step) => step.status),
    ).toEqual(['interrupted', 'completed']);
  });

  it.each(['queued', 'waiting', 'retrying'])(
    'uses explicit %s signals while running',
    (status) => {
      const start = event(Type.TOOL_START, 'start', 10);
      start.payload.metadata = { status };
      expect(consolidateSteps([start])[0].status).toBe(status);
      expect(consolidateSteps([start], true)[0].status).toBe('interrupted');
    },
  );

  it('summarizes concrete result counts without exposing a model prompt', () => {
    const [tool] = consolidateSteps([
      event(Type.TOOL_END, 'end', 12, {
        output: JSON.stringify({
          results: [{ title: 'one' }, { title: 'two' }],
        }),
      }),
    ]);
    expect(getOutcomeSummary(tool)).toBe('2 results');
    const [llm] = consolidateSteps([
      event(Type.LLM_END, 'model', 12, { output: 'private model trace' }),
    ]);
    expect(getOutcomeSummary(llm)).toBe('Completed');
  });
});
