// @vitest-environment node
import {
  parseAnthropicMessagesRequest,
  validateAnthropicHeaders,
} from '@/server/compat/anthropicRequest';
import { CompatError } from '@/server/compat/errors';
import { parseOpenAIChatRequest } from '@/server/compat/openaiRequest';
import { describe, expect, it } from 'vitest';

function rejection(fn: () => unknown): CompatError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CompatError);
    return error as CompatError;
  }
  throw new Error('expected a CompatError');
}

const openai = (extra: Record<string, unknown> = {}) => ({
  model: 'daedalus',
  messages: [{ role: 'user', content: 'Hello' }],
  ...extra,
});

const anthropic = (extra: Record<string, unknown> = {}) => ({
  model: 'daedalus',
  max_tokens: 256,
  messages: [{ role: 'user', content: 'Hello' }],
  ...extra,
});

describe('OpenAI Chat Completions request contract', () => {
  it('normalizes history, text parts, and system/developer instructions', () => {
    const request = parseOpenAIChatRequest(
      openai({
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: [{ type: 'text', text: 'First' }] },
          {
            role: 'assistant',
            content: 'Answer',
            refusal: null,
            tool_calls: [],
            annotations: [],
          },
          {
            role: 'developer',
            content: [{ type: 'text', text: 'Use bullets.' }],
          },
          { role: 'user', content: 'Résumé ✓ 👋' },
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 50,
        temperature: 0.2,
        user: 'client-user',
      }),
    );
    expect(request).toEqual({
      protocol: 'openai',
      model: 'daedalus',
      messages: [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Answer' },
        { role: 'user', content: 'Résumé ✓ 👋' },
      ],
      instructions: 'Be brief.\n\nUse bullets.',
      stream: true,
      includeUsage: true,
      maxOutputTokens: 50,
      ignoredParameters: ['temperature', 'user'],
    });
  });

  it('defaults to a non-streaming request without an output limit', () => {
    const request = parseOpenAIChatRequest(openai({ max_tokens: 9 }));
    expect(request.stream).toBe(false);
    expect(request.includeUsage).toBe(false);
    expect(request.maxOutputTokens).toBe(9);
    expect(parseOpenAIChatRequest(openai()).maxOutputTokens).toBeNull();
  });

  it.each([
    ['unknown model', openai({ model: 'gpt-4o' }), 'not_found', 'model'],
    ['missing model', openai({ model: undefined }), 'invalid_request', 'model'],
    ['empty messages', openai({ messages: [] }), 'invalid_request', 'messages'],
    [
      'client tools',
      openai({ tools: [{ type: 'function', function: { name: 'x' } }] }),
      'invalid_request',
      'tools',
    ],
    [
      'tool role',
      openai({
        messages: [
          { role: 'user', content: 'x' },
          { role: 'tool', content: 'y', tool_call_id: 'c' },
        ],
      }),
      'invalid_request',
      'messages[1].role',
    ],
    [
      'assistant tool calls',
      openai({
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c' }] },
          { role: 'user', content: 'y' },
        ],
      }),
      'invalid_request',
      'messages[1].tool_calls',
    ],
    [
      'image content',
      openai({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'x' } }],
          },
        ],
      }),
      'invalid_request',
      'messages[0].content[0].type',
    ],
    [
      'both output limits',
      openai({ max_tokens: 1, max_completion_tokens: 1 }),
      'invalid_request',
      'max_tokens',
    ],
    [
      'zero output limit',
      openai({ max_tokens: 0 }),
      'invalid_request',
      'max_tokens',
    ],
    ['multiple choices', openai({ n: 2 }), 'invalid_request', 'n'],
    ['stop sequences', openai({ stop: ['x'] }), 'invalid_request', 'stop'],
    [
      'json mode',
      openai({ response_format: { type: 'json_object' } }),
      'invalid_request',
      'response_format',
    ],
    ['stored completions', openai({ store: true }), 'invalid_request', 'store'],
    ['logprobs', openai({ logprobs: true }), 'invalid_request', 'logprobs'],
    [
      'reasoning effort',
      openai({ reasoning_effort: 'high' }),
      'invalid_request',
      'reasoning_effort',
    ],
    [
      'unknown field',
      openai({ frobnicate: 1 }),
      'invalid_request',
      'frobnicate',
    ],
    [
      'stream options without stream',
      openai({ stream_options: { include_usage: true } }),
      'invalid_request',
      'stream_options',
    ],
    [
      'out-of-range advisory',
      openai({ temperature: 5 }),
      'invalid_request',
      'temperature',
    ],
    [
      'participant names',
      openai({ messages: [{ role: 'user', content: 'x', name: 'n' }] }),
      'invalid_request',
      'messages[0].name',
    ],
    [
      'assistant prefill',
      openai({
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: 'partial' },
        ],
      }),
      'invalid_request',
      'messages',
    ],
    [
      'only instructions',
      openai({ messages: [{ role: 'system', content: 'x' }] }),
      'invalid_request',
      'messages',
    ],
  ])('rejects %s before admission', (_name, body, kind, param) => {
    const error = rejection(() => parseOpenAIChatRequest(body));
    expect(error.kind).toBe(kind);
    expect(error.param).toBe(param);
  });

  it('accepts no-op tool settings and the text response format', () => {
    const request = parseOpenAIChatRequest(
      openai({
        tools: [],
        tool_choice: 'none',
        response_format: { type: 'text' },
        modalities: ['text'],
        n: 1,
        store: false,
        logprobs: false,
        parallel_tool_calls: false,
      }),
    );
    expect(request.ignoredParameters).toEqual(['parallel_tool_calls']);
  });

  it('bounds the history size before admission', () => {
    const many = Array.from({ length: 501 }, () => ({
      role: 'user',
      content: 'x',
    }));
    expect(
      rejection(() => parseOpenAIChatRequest(openai({ messages: many }))).kind,
    ).toBe('request_too_large');
  });
});

describe('Anthropic Messages request contract', () => {
  it('normalizes text blocks and system blocks, recording advisory fields', () => {
    const request = parseAnthropicMessagesRequest(
      anthropic({
        system: [
          {
            type: 'text',
            text: 'Be brief.',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
          { role: 'assistant', content: 'Hello' },
          { role: 'user', content: 'Weather?' },
        ],
        temperature: 0.5,
        metadata: { user_id: 'u-1' },
        stream: true,
      }),
    );
    expect(request).toMatchObject({
      protocol: 'anthropic',
      instructions: 'Be brief.',
      stream: true,
      includeUsage: true,
      maxOutputTokens: 256,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Weather?' },
      ],
    });
    expect(request.ignoredParameters.sort()).toEqual(
      ['cache_control', 'metadata', 'temperature'].sort(),
    );
  });

  it.each([
    ['missing max_tokens', anthropic({ max_tokens: undefined }), 'max_tokens'],
    ['fractional max_tokens', anthropic({ max_tokens: 1.5 }), 'max_tokens'],
    ['tools', anthropic({ tools: [{ name: 't', input_schema: {} }] }), 'tools'],
    [
      'forced tool choice',
      anthropic({ tool_choice: { type: 'any' } }),
      'tool_choice',
    ],
    [
      'thinking',
      anthropic({ thinking: { type: 'enabled', budget_tokens: 1024 } }),
      'thinking',
    ],
    ['stop sequences', anthropic({ stop_sequences: ['x'] }), 'stop_sequences'],
    [
      'tool results',
      anthropic({
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }],
          },
        ],
      }),
      'messages.0.content.0.type',
    ],
    [
      'images',
      anthropic({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url: 'x' } }],
          },
        ],
      }),
      'messages.0.content.0.type',
    ],
    [
      'system role',
      anthropic({ messages: [{ role: 'system', content: 'x' }] }),
      'messages.0.role',
    ],
    ['mcp servers', anthropic({ mcp_servers: [{ url: 'x' }] }), 'mcp_servers'],
    ['unknown field', anthropic({ unknown: true }), 'unknown'],
  ])('rejects %s', (_name, body, param) => {
    const error = rejection(() => parseAnthropicMessagesRequest(body));
    expect(error.kind).toBe('invalid_request');
    expect(error.param).toBe(param);
  });

  it('accepts disabled thinking and an automatic tool choice without tools', () => {
    expect(() =>
      parseAnthropicMessagesRequest(
        anthropic({
          thinking: { type: 'disabled' },
          tool_choice: { type: 'auto' },
          tools: [],
          stop_sequences: [],
        }),
      ),
    ).not.toThrow();
  });

  it('applies the sampling-parameter contract of each supported version', () => {
    const sampled = anthropic({ temperature: 1, top_k: 5 });
    expect(
      parseAnthropicMessagesRequest(sampled, {
        'anthropic-version': '2023-06-01',
      }).ignoredParameters.sort(),
    ).toEqual(['temperature', 'top_k']);
    const error = rejection(() =>
      parseAnthropicMessagesRequest(sampled, {
        'anthropic-version': '2026-10-21',
      }),
    );
    expect(error.param).toBe('temperature');
    expect(error.kind).toBe('invalid_request');
    expect(() =>
      parseAnthropicMessagesRequest(anthropic(), {
        'anthropic-version': '2026-10-21',
      }),
    ).not.toThrow();
  });

  it('requires a supported version header and refuses beta features', () => {
    for (const version of ['2023-06-01', '2026-10-21']) {
      expect(() =>
        validateAnthropicHeaders({ 'anthropic-version': version }),
      ).not.toThrow();
    }
    expect(rejection(() => validateAnthropicHeaders({})).param).toBe(
      'anthropic-version',
    );
    expect(
      rejection(() =>
        validateAnthropicHeaders({ 'anthropic-version': '2099-01-01' }),
      ).param,
    ).toBe('anthropic-version');
    expect(
      rejection(() =>
        validateAnthropicHeaders({
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
        }),
      ).param,
    ).toBe('anthropic-beta');
  });
});

describe('caller instruction placement', () => {
  it('sits directly before the final user turn so history selection keeps it', async () => {
    const { withCallerInstructions } = await import('@/server/chat/submission');
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
