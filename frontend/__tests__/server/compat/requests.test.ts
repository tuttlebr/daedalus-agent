// @vitest-environment node
import {
  parseAnthropicMessagesRequest,
  validateAnthropicHeaders,
} from '@/server/compat/anthropicRequest';
import { CompatError } from '@/server/compat/errors';
import { parseOpenAIChatRequest } from '@/server/compat/openaiRequest';
import { parseResponsesRequest } from '@/server/compat/responsesRequest';
import { describe, expect, it } from 'vitest';

// Request fields from the official create schemas (2026-11-07). Each advisory
// fixture must be accepted and explicitly reported, without entering agent input.
const chatAdvisory = {
  audio: { format: 'wav', voice: 'alloy' },
  frequency_penalty: 1,
  function_call: { name: 'weather' },
  functions: [{ name: 'weather', parameters: { type: 'object' } }],
  logit_bias: { '42': 1 },
  logprobs: true,
  top_logprobs: 5,
  metadata: { caller: 'test' },
  modalities: ['text', 'audio'],
  moderation: { model: 'omni-moderation-latest' },
  n: 3,
  parallel_tool_calls: true,
  prediction: { type: 'content', content: 'predicted' },
  presence_penalty: 1,
  prompt_cache_key: 'key',
  prompt_cache_options: { mode: 'explicit', ttl: '30m' },
  prompt_cache_retention: '24h',
  reasoning_effort: 'high',
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'answer', schema: { type: 'object' } },
  },
  safety_identifier: 'caller',
  seed: 123,
  service_tier: 'priority',
  stop: ['END'],
  store: true,
  temperature: 0.5,
  tool_choice: 'required',
  tools: [
    {
      type: 'function',
      function: { name: 'weather', parameters: { type: 'object' } },
    },
  ],
  top_p: 0.5,
  user: 'user',
  verbosity: 'high',
  web_search_options: { search_context_size: 'medium' },
};
const responsesAdvisory = {
  access_programs: { cyber: 'standard' },
  background: true,
  context_management: [{ type: 'compaction', compact_threshold: 1000 }],
  conversation: { id: 'conv_external' },
  image: { context_compression: 'auto' },
  include: ['file_search_call.results'],
  max_tool_calls: 5,
  metadata: { caller: 'test' },
  moderation: { model: 'omni-moderation-latest' },
  parallel_tool_calls: false,
  previous_response_id: 'resp_external',
  prompt: { id: 'pmpt_external', variables: { topic: 'test' } },
  prompt_cache_key: 'key',
  prompt_cache_options: { mode: 'explicit', ttl: '30m', prewarm: true },
  prompt_cache_retention: '24h',
  reasoning: { effort: 'high', summary: 'auto' },
  safety_identifier: 'caller',
  service_tier: 'flex',
  store: true,
  stream_options: { include_obfuscation: true },
  temperature: 0.5,
  text: { format: { type: 'json_object' }, verbosity: 'low' },
  tool_choice: 'required',
  tools: [{ type: 'file_search', vector_store_ids: ['vs_external'] }],
  top_logprobs: 5,
  top_p: 0.5,
  truncation: 'auto',
  user: 'caller',
};
const anthropicAdvisory = {
  cache_control: { type: 'ephemeral' },
  container: { id: 'external' },
  diagnostics: { previous_message_id: 'msg_external' },
  inference_geo: 'us',
  metadata: { user_id: 'caller' },
  output_config: {
    format: { type: 'json_schema', schema: { type: 'object' } },
  },
  service_tier: 'standard_only',
  speed: 'fast',
  stop_sequences: ['END'],
  thinking: { type: 'enabled', budget_tokens: 1024 },
  tool_choice: { type: 'any' },
  tools: [{ name: 'weather', input_schema: { type: 'object' } }],
  temperature: 0.5,
  top_p: 0.5,
  top_k: 5,
  mcp_servers: [
    { type: 'url', name: 'remote', url: 'https://external.invalid/mcp' },
  ],
  context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
  output_format: { type: 'json_schema', schema: { type: 'object' } },
};
const chat = {
  model: 'daedalus',
  messages: [{ role: 'user', content: 'Hello' }],
};
const responses = { model: 'daedalus', input: 'Hello' };
const anthropic = { ...chat, max_tokens: 256 };

for (const [name, parse, base, advisory] of [
  ['Chat Completions', parseOpenAIChatRequest, chat, chatAdvisory],
  ['Responses', parseResponsesRequest, responses, responsesAdvisory],
  ['Messages', parseAnthropicMessagesRequest, anthropic, anthropicAdvisory],
] as const) {
  describe(name, () => {
    it.each(Object.entries(advisory))('accepts and drops %s', (key, value) => {
      const normalized = parse({ ...base, [key]: value });
      expect(normalized.ignoredParameters).toContain(key);
      expect(normalized.messages).toEqual([{ role: 'user', content: 'Hello' }]);
      expect(normalized.instructions).toBeNull();
    });
    it('accepts the complete parameter set together', () => {
      const normalized = parse({ ...base, ...advisory, stream: true });
      expect(normalized.stream).toBe(true);
      expect(normalized.ignoredParameters.sort()).toEqual(
        Object.keys(advisory).sort(),
      );
    });
    it('maps vendor model names to the agent without selecting a provider', () => {
      const normalized = parse({ ...base, model: 'vendor-model' });
      expect(normalized.model).toBe('daedalus');
      expect(normalized.ignoredParameters).toContain('model');
    });
    it('rejects malformed envelopes and unknown top-level parameters', () => {
      for (const body of [
        [],
        null,
        { ...base, stream: 'yes' },
        { ...base, unexpected: true },
      ]) {
        expect(() => parse(body)).toThrow(CompatError);
      }
    });
    it('bounds retained text before admission', () => {
      const body =
        name === 'Responses'
          ? { ...base, input: 'x'.repeat(2 * 1024 * 1024 + 1) }
          : {
              ...base,
              messages: [
                { role: 'user', content: 'x'.repeat(2 * 1024 * 1024 + 1) },
              ],
            };
      expect(() => parse(body)).toThrow(CompatError);
    });
  });
}

describe('conversation normalization', () => {
  it('preserves Chat text, instructions, refusals, tool results and participant names', () => {
    const result = parseOpenAIChatRequest({
      ...chat,
      messages: [
        { role: 'system', content: 'Brief.' },
        { role: 'developer', content: 'Bullets.' },
        {
          role: 'user',
          name: 'caller',
          content: [
            { type: 'text', text: 'Hello' },
            {
              type: 'image_url',
              image_url: { url: 'https://external.invalid/image' },
            },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call',
              type: 'function',
              function: { name: 'weather', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call', content: 'Sunny' },
        {
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'Cannot do that' }],
        },
      ],
      stream: true,
      stream_options: { include_usage: true, include_obfuscation: true },
      max_tokens: 9,
      max_completion_tokens: 12,
    });
    expect(result.instructions).toBe('Brief.\n\nBullets.');
    expect(result.messages.map((m) => m.content)).toEqual([
      'Hello',
      'Sunny',
      'Cannot do that',
      'Continue the preceding assistant response.',
    ]);
    expect(result.includeUsage).toBe(true);
    expect(result.maxOutputTokens).toBe(12);
    expect(result.ignoredParameters).toEqual(
      expect.arrayContaining([
        'messages',
        'messages.content',
        'messages.role',
        'stream_options',
        'max_tokens',
      ]),
    );
  });

  it('accepts Responses message/output replay and drops external references', () => {
    const result = parseResponsesRequest({
      ...responses,
      instructions: 'Brief.',
      input: [
        { role: 'developer', content: 'Bullets.' },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Hello' },
            { type: 'input_file', file_id: 'file_external' },
          ],
        },
        {
          id: 'msg_external',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Earlier', annotations: [] }],
        },
        {
          type: 'function_call',
          call_id: 'call',
          name: 'weather',
          arguments: '{}',
        },
        { type: 'function_call_output', call_id: 'call', output: 'Sunny' },
        { type: 'item_reference', id: 'external' },
        { type: 'reasoning', encrypted_content: 'private', summary: [] },
      ],
      max_output_tokens: 12,
    });
    expect(result.messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Earlier' },
      { role: 'user', content: 'Sunny' },
    ]);
    expect(result.instructions).toBe('Brief.\n\nBullets.');
    expect(result.maxOutputTokens).toBe(12);
    expect(result.ignoredParameters).toEqual(
      expect.arrayContaining(['input', 'input.content', 'input.tool_calls']),
    );
  });

  it('accepts Anthropic cache, thinking, tool-result, image and document blocks', () => {
    const result = parseAnthropicMessagesRequest({
      ...anthropic,
      system: [
        { type: 'text', text: 'Brief.', cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private', signature: 'sig' },
            { type: 'tool_use', id: 'call', name: 'weather', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call',
              content: [{ type: 'text', text: 'Sunny' }],
            },
            {
              type: 'image',
              source: { type: 'url', url: 'https://external.invalid/image' },
            },
            { type: 'document', source: { type: 'file', file_id: 'external' } },
          ],
        },
      ],
    });
    expect(result.instructions).toBe('Brief.');
    expect(result.messages).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'user', content: 'Sunny' },
    ]);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('external.invalid');
  });

  it('accepts textless and reference-only requests without resolving references', () => {
    for (const result of [
      parseResponsesRequest({ prompt: { id: 'external' } }),
      parseResponsesRequest({ input: [] }),
      parseOpenAIChatRequest({
        ...chat,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: { data: 'base64', format: 'wav' },
              },
            ],
          },
        ],
      }),
      parseAnthropicMessagesRequest({
        ...anthropic,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'url', url: 'https://external.invalid/image' },
              },
            ],
          },
        ],
      }),
    ]) {
      expect(result.messages.at(-1)?.content).toContain(
        'Ask the caller to provide text',
      );
    }
  });

  it('does not put arbitrary content keys in HTTP headers', () => {
    const result = parseOpenAIChatRequest({
      ...chat,
      messages: [
        {
          role: 'user',
          'bad\r\nheader': true,
          content: [{ type: 'text', text: 'Hi', 'bad\r\nheader': true }],
        },
      ],
    });
    expect(result.ignoredParameters.join(',')).not.toMatch(/[\r\n]/);
  });

  it('rejects invalid message roles, token limits, and excessive histories', () => {
    for (const parse of [
      parseOpenAIChatRequest,
      parseAnthropicMessagesRequest,
    ]) {
      expect(() =>
        parse({ ...anthropic, messages: [{ role: 'invalid', content: 'Hi' }] }),
      ).toThrow(CompatError);
      expect(() =>
        parse({
          ...anthropic,
          messages: Array.from({ length: 501 }, () => chat.messages[0]),
        }),
      ).toThrow(CompatError);
    }
    expect(() => parseOpenAIChatRequest({ ...chat, max_tokens: 0 })).toThrow(
      CompatError,
    );
    expect(() => parseAnthropicMessagesRequest(chat)).toThrow(CompatError);
    expect(() =>
      parseResponsesRequest({ ...responses, max_output_tokens: -1 }),
    ).toThrow(CompatError);
    expect(
      parseAnthropicMessagesRequest({ ...anthropic, max_tokens: 0 })
        .maxOutputTokens,
    ).toBe(0);
  });

  it('accepts current, legacy and beta Anthropic headers as advisory', () => {
    for (const version of ['2023-06-01', '2026-10-21', '2099-01-01']) {
      const headers = {
        'anthropic-version': version,
        'anthropic-beta': 'prompt-caching-2024-07-31',
      };
      expect(() => validateAnthropicHeaders(headers)).not.toThrow();
      expect(
        parseAnthropicMessagesRequest(
          { ...anthropic, temperature: 0.5 },
          headers,
        ).ignoredParameters,
      ).toContain('anthropic-beta');
    }
    expect(() => validateAnthropicHeaders({})).not.toThrow();
    expect(() =>
      validateAnthropicHeaders({ 'anthropic-version': 'invalid' }),
    ).toThrow(CompatError);
  });
});
describe('caller instruction placement', () => {
  it('sits directly before the final user turn so history selection keeps it', async () => {
    const { withCallerInstructions } = await import(
      '@/server/chat/callerInstructions'
    );
    const instructions = {
      role: 'user' as const,
      content: '[CALLER_INSTRUCTIONS] x',
    };
    const history = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'user', content: 'd' },
    ];
    expect(
      withCallerInstructions(history, instructions).map((m) => m.content),
    ).toEqual(['a', 'b', '[CALLER_INSTRUCTIONS] x', 'c', 'd']);
    expect(withCallerInstructions(history, null)).toBe(history);
    expect(
      withCallerInstructions([{ role: 'user', content: 'only' }], instructions),
    ).toEqual([instructions, { role: 'user', content: 'only' }]);
  });
});
