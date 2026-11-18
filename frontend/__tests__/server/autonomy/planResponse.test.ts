// @vitest-environment node
import { parsePlanResponse } from '@/server/autonomy/planResponse';
import { expect, it } from 'vitest';

const frame = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
const end = 'data: [DONE]\n\n';

it('assembles streamed JSON and Unicode, ignores reasoning and usage', () => {
  const raw =
    ': keepalive\n\n' +
    frame({ role: 'assistant' }) +
    frame({ reasoning_content: 'private thought' }) +
    frame({ content: '{"message":' }) +
    frame({ content: '"雪🌲"}' }, 'stop') +
    'data: {"choices":[],"usage":{"total_tokens":9}}\n\n' +
    end;
  const result = parsePlanResponse(raw.replace(/\n/g, '\r\n'), true);
  expect(JSON.parse(result.choices[0].message.content)).toEqual({
    message: '雪🌲',
  });
  expect(JSON.stringify(result)).not.toContain('private thought');
});

it.each([
  frame({ content: '{}' }, 'stop'),
  frame({ content: '{}' }) + end,
  frame({ content: '{}' }, 'stop') +
    'data: {"error":{"message":"private"}}\n\n' +
    end,
  frame({ content: '{}' }, 'stop') + frame({ content: 'late' }) + end,
  frame({ content: '{}' }, 'stop') + frame({}, 'length') + end,
  frame({ content: '{}' }, 'stop') + end + frame({ content: 'late' }),
])(
  'rejects incomplete or contradictory streams without exposing diagnostics',
  (raw) => {
    expect(() => parsePlanResponse(raw, true)).toThrow();
  },
);

it('retains refusal, truncation and tool-call signals for the existing handler', () => {
  expect(
    parsePlanResponse(
      frame({ refusal: 'Declined' }, 'content_filter') + end,
      true,
    ).choices[0].message.refusal,
  ).toBe('Declined');
  expect(
    parsePlanResponse(frame({ content: '{' }, 'length') + end, true).choices[0]
      .finish_reason,
  ).toBe('length');
  expect(
    parsePlanResponse(
      frame({ tool_calls: [{ index: 0 }] }, 'tool_calls') + end,
      true,
    ).choices[0].message.tool_calls,
  ).toHaveLength(1);
});

it('bounds generated plan size and accepts the old JSON response during rollout', () => {
  expect(() =>
    parsePlanResponse(
      frame({ content: 'a'.repeat(65537) }, 'stop') + end,
      true,
    ),
  ).toThrow();
  const old = {
    choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
  };
  expect(parsePlanResponse(JSON.stringify(old), false)).toEqual(old);
});
