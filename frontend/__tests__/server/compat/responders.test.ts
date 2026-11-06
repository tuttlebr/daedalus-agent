// @vitest-environment node
import type { RunUsage } from '@/server/chat/types';
import { CompatError } from '@/server/compat/errors';
import { absolutizeAppLinks, publicOrigin } from '@/server/compat/links';
import {
  applyOutputBudget,
  estimateTokens,
} from '@/server/compat/outputBudget';
import {
  anthropicUsage,
  createAnthropicResponder,
  createOpenAIResponder,
  openAIUsage,
  usageCompleteness,
} from '@/server/compat/responders';
import { outcomeFromStatus } from '@/server/compat/runObserver';
import { Stream as AnthropicStream } from '@anthropic-ai/sdk/core/streaming';
import { Stream as OpenAIStream } from 'openai/core/streaming';
import { describe, expect, it } from 'vitest';

function fakeResponse() {
  const res: any = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined as unknown,
    chunks: [] as string[],
    writableEnded: false,
    destroyed: false,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = String(value);
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(value: unknown) {
      res.body = value;
      res.writableEnded = true;
      return res;
    },
    flushHeaders() {},
    write(chunk: string) {
      res.chunks.push(chunk);
      return true;
    },
    end() {
      res.writableEnded = true;
    },
  };
  return res;
}

function sseResponse(text: string): Response {
  return new Response(text, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

const usage: RunUsage = {
  modelCalls: 3,
  inputTokens: 1200,
  outputTokens: 80,
  cachedTokens: 200,
  reportedInputTokens: 1200,
  reportedOutputTokens: 80,
  reportedCachedTokens: 200,
};
const partialUsage: RunUsage = {
  ...usage,
  inputTokens: null,
  outputTokens: null,
  reportedInputTokens: 700,
  reportedOutputTokens: 30,
};

describe('OpenAI responder', () => {
  it('returns a standard completion with complete usage only', () => {
    const res = fakeResponse();
    createOpenAIResponder(res, {
      runId: 'run-1',
      model: 'daedalus',
      stream: false,
      includeUsage: false,
      created: 1,
    }).sendCompletion({ text: 'Hi', truncated: false, usage });
    expect(res.body).toEqual({
      id: 'chatcmpl-run-1',
      object: 'chat.completion',
      created: 1,
      model: 'daedalus',
      system_fingerprint: null,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hi',
            refusal: null,
            annotations: [],
          },
          logprobs: null,
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
        prompt_tokens_details: { cached_tokens: 200 },
      },
    });
    expect(openAIUsage(partialUsage)).toBeNull();
    expect(openAIUsage(undefined)).toBeNull();
  });

  it('streams frames the official SDK parses, with usage and [DONE]', async () => {
    const res = fakeResponse();
    const responder = createOpenAIResponder(res, {
      runId: 'run-2',
      model: 'daedalus',
      stream: true,
      includeUsage: true,
    });
    responder.startStream();
    responder.keepalive();
    const long = 'é'.repeat(5000) + '👋';
    responder.finishStream({ text: long, truncated: true, usage });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-transform');
    const chunks: any[] = [];
    for await (const chunk of OpenAIStream.fromSSEResponse<any>(
      sseResponse(res.chunks.join('')),
      new AbortController(),
    )) {
      chunks.push(chunk);
    }
    expect(chunks[0].choices[0].delta).toEqual({
      role: 'assistant',
      content: '',
    });
    const text = chunks
      .flatMap((chunk) => chunk.choices)
      .map((choice: any) => choice.delta?.content ?? '')
      .join('');
    expect(text).toBe(long);
    const finish = chunks.find((c) => c.choices[0]?.finish_reason);
    expect(finish.choices[0].finish_reason).toBe('length');
    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: { total_tokens: 1280 },
    });
    expect(chunks.slice(0, -1).every((c) => c.usage === null)).toBe(true);
  });

  it('raises an SDK APIError for a failure after streaming starts', async () => {
    const res = fakeResponse();
    const responder = createOpenAIResponder(res, {
      runId: 'run-3',
      model: 'daedalus',
      stream: true,
      includeUsage: false,
    });
    responder.startStream();
    responder.failStream(
      new CompatError('api_error', 'The Daedalus run failed.', {
        code: 'run_failed',
        details: { runId: 'run-3' },
      }),
    );
    const iterate = async () => {
      for await (const _ of OpenAIStream.fromSSEResponse(
        sseResponse(res.chunks.join('')),
        new AbortController(),
      )) {
        // drain
      }
    };
    await expect(iterate()).rejects.toThrow('The Daedalus run failed.');
  });

  it('marks pre-execution errors retryable and execution errors final', () => {
    const before = fakeResponse();
    createOpenAIResponder(before, {
      runId: 'r',
      model: 'daedalus',
      stream: false,
      includeUsage: false,
    }).sendError(
      new CompatError('rate_limit', 'busy', {
        retryable: true,
        retryAfterSeconds: 5,
      }),
    );
    expect(before.statusCode).toBe(429);
    expect(before.headers['x-should-retry']).toBe('true');
    expect(before.headers['retry-after']).toBe('5');

    const after = fakeResponse();
    createOpenAIResponder(after, {
      runId: 'r',
      model: 'daedalus',
      stream: false,
      includeUsage: false,
    }).sendError(
      new CompatError('authorization_required', 'approve', {
        code: 'approval_required',
        details: {
          runId: 'r',
          conversationId: 'api-r',
          actionUrl: 'https://d/?conversation=api-r',
          requirement: 'mcp_approval',
        },
      }),
    );
    expect(after.statusCode).toBe(403);
    expect(after.headers['x-should-retry']).toBe('false');
    expect(after.body.error).toMatchObject({
      type: 'permission_error',
      code: 'approval_required',
      daedalus: {
        run_id: 'r',
        conversation_id: 'api-r',
        action_url: 'https://d/?conversation=api-r',
        requirement: 'mcp_approval',
      },
    });
  });
});

describe('Anthropic responder', () => {
  it('returns a Messages object and reports usage completeness', () => {
    const res = fakeResponse();
    createAnthropicResponder(res, {
      runId: 'a-b-c',
      model: 'daedalus',
      stream: false,
      includeUsage: true,
    }).sendCompletion({ text: 'Hi', truncated: true, usage });
    expect(res.body).toEqual({
      id: 'msg_abc',
      type: 'message',
      role: 'assistant',
      model: 'daedalus',
      content: [{ type: 'text', text: 'Hi', citations: null }],
      stop_reason: 'max_tokens',
      stop_sequence: null,
      stop_details: null,
      container: null,
      diagnostics: null,
      usage: {
        input_tokens: 1000,
        output_tokens: 80,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 200,
        cache_creation: null,
        inference_geo: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
        speed: null,
      },
    });
    expect(res.headers['x-daedalus-usage']).toBe('complete');
  });

  it('reports measured lower bounds, never estimates, for partial usage', () => {
    expect(anthropicUsage(partialUsage)).toMatchObject({
      input_tokens: 500,
      output_tokens: 30,
    });
    expect(usageCompleteness(partialUsage)).toBe('partial');
    expect(anthropicUsage(undefined)).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });
    expect(usageCompleteness(undefined)).toBe('unavailable');
  });

  it('streams the message lifecycle the official SDK accumulates', async () => {
    const res = fakeResponse();
    const responder = createAnthropicResponder(res, {
      runId: 'run-4',
      model: 'daedalus',
      stream: true,
      includeUsage: true,
    });
    responder.startStream();
    responder.keepalive();
    responder.finishStream({ text: 'Unicode ✓ 👋', truncated: false, usage });
    const events: any[] = [];
    for await (const event of AnthropicStream.fromSSEResponse<any>(
      sseResponse(res.chunks.join('')),
      new AbortController(),
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(events[2].delta).toEqual({
      type: 'text_delta',
      text: 'Unicode ✓ 👋',
    });
    expect(events[4]).toMatchObject({
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 1000, output_tokens: 80 },
    });
  });

  it('raises an SDK error for an in-stream error event', async () => {
    const res = fakeResponse();
    const responder = createAnthropicResponder(res, {
      runId: 'run-5',
      model: 'daedalus',
      stream: true,
      includeUsage: true,
    });
    responder.startStream();
    responder.failStream(new CompatError('api_error', 'Run failed'));
    const iterate = async () => {
      for await (const _ of AnthropicStream.fromSSEResponse(
        sseResponse(res.chunks.join('')),
        new AbortController(),
      )) {
        // drain
      }
    };
    await expect(iterate()).rejects.toThrow('Run failed');
  });

  it('maps capacity errors to overloaded_error', () => {
    const res = fakeResponse();
    createAnthropicResponder(res, {
      runId: 'r',
      model: 'daedalus',
      stream: false,
      includeUsage: true,
    }).sendError(new CompatError('overloaded', 'later', { retryable: true }));
    expect(res.statusCode).toBe(529);
    expect(res.body).toEqual({
      type: 'error',
      error: { type: 'overloaded_error', message: 'later' },
      request_id: 'r',
    });
  });
});

describe('final-answer budget and links', () => {
  it('estimates one token per four UTF-8 bytes and cuts on code points', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(applyOutputBudget('abcdefgh', null)).toEqual({
      text: 'abcdefgh',
      truncated: false,
    });
    expect(applyOutputBudget('abcdefgh', 1)).toEqual({
      text: 'abcd',
      truncated: true,
    });
    // 👋 is four bytes and a surrogate pair; it is never split.
    expect(applyOutputBudget('ab👋cd', 1)).toEqual({
      text: 'ab',
      truncated: true,
    });
  });

  it('gives app-relative Markdown targets the deployment origin', () => {
    expect(
      absolutizeAppLinks(
        '![img](/api/generated-image/x) [ext](https://e.com) [p](//cdn/x)',
        'https://daedalus.lan',
      ),
    ).toBe(
      '![img](https://daedalus.lan/api/generated-image/x) [ext](https://e.com) [p](//cdn/x)',
    );
    expect(absolutizeAppLinks('[a](/x)', null)).toBe('[a](/x)');
    expect(
      publicOrigin({ host: 'daedalus.lan', 'x-forwarded-proto': 'https' }),
    ).toBe('https://daedalus.lan');
    expect(publicOrigin({ host: 'bad host\r\nx' })).toBeNull();
    // Direct access without a proxy follows the socket.
    expect(publicOrigin({ host: '127.0.0.1:15002' })).toBe(
      'http://127.0.0.1:15002',
    );
    expect(publicOrigin({ host: 'd.lan' }, true)).toBe('https://d.lan');
    process.env.DAEDALUS_PUBLIC_URL = 'https://daedalus.example/app';
    expect(publicOrigin({ host: 'internal:5000' })).toBe(
      'https://daedalus.example',
    );
    delete process.env.DAEDALUS_PUBLIC_URL;
  });
});

describe('run outcome mapping', () => {
  const base = { jobId: 'j', createdAt: 1, updatedAt: 1 };
  it('maps live, terminal and missing job statuses', () => {
    expect(outcomeFromStatus({ ...base, status: 'pending' })).toBeNull();
    expect(outcomeFromStatus({ ...base, status: 'streaming' })).toBeNull();
    expect(outcomeFromStatus(null)).toEqual({ kind: 'unavailable' });
    expect(
      outcomeFromStatus({
        ...base,
        status: 'completed',
        fullResponse: 'Done',
        usage,
      }),
    ).toEqual({ kind: 'completed', text: 'Done', usage });
    expect(
      outcomeFromStatus({
        ...base,
        status: 'error',
        error: 'Job canceled by user',
      }),
    ).toEqual({ kind: 'cancelled' });
    expect(
      outcomeFromStatus({ ...base, status: 'error', error: 'Backend failed' }),
    ).toEqual({ kind: 'failed', message: 'Backend failed' });
    expect(
      outcomeFromStatus({
        ...base,
        status: 'oauth_required',
        oauthRequests: [{ id: 'x', authUrl: 'https://g', service: 'calendar' }],
      }),
    ).toEqual({ kind: 'oauth_required', service: 'calendar' });
  });

  it('recognizes an approval marker as an authorization requirement', () => {
    const marker = `<!--daedalus-mcp-approval:${Buffer.from(
      JSON.stringify({
        version: 1,
        requestId: 'approval_request_123',
        serverName: 'docs',
        toolName: 'update_doc',
        target: 'doc-1',
        summary: 'Update document doc-1',
        argumentsSha256: 'a'.repeat(64),
      }),
    ).toString('base64url')}-->`;
    expect(
      outcomeFromStatus({
        ...base,
        status: 'completed',
        fullResponse: marker,
        conversationId: 'api-j',
      }),
    ).toEqual({
      kind: 'approval_required',
      conversationId: 'api-j',
      summary: 'Update document doc-1',
    });
  });
});
