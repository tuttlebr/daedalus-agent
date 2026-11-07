// @vitest-environment node
import { ApiRouteError } from '@/server/chat/types';
import {
  parseAnthropicMessagesRequest,
  validateAnthropicHeaders,
} from '@/server/compat/anthropicRequest';
import { handleCompatChat } from '@/server/compat/execution';
import { parseOpenAIChatRequest } from '@/server/compat/openaiRequest';
import {
  createAnthropicResponder,
  createOpenAIResponder,
} from '@/server/compat/responders';
import { ConversationWriteError } from '@/server/session/conversationStore';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  submit: vi.fn(),
  wait: vi.fn(),
  readStatus: vi.fn(),
  cancel: vi.fn(),
  claim: vi.fn(),
  settle: vi.fn(),
  release: vi.fn(),
  rate: vi.fn(),
}));

vi.mock('@/server/compat/auth', () => ({
  authenticateCompatRequest: mocks.authenticate,
}));
vi.mock('@/server/chat/submission', () => ({ submitChatJob: mocks.submit }));
vi.mock('@/server/chat/cancellation', () => ({ cancelChatJob: mocks.cancel }));
vi.mock('@/server/rateLimit', () => ({
  checkRateLimit: mocks.rate,
  ruleFromEnv: (name: string) => ({ name, limit: 40, windowSeconds: 60 }),
}));
vi.mock('@/server/compat/runObserver', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  waitForRunOutcome: mocks.wait,
  readJobStatus: mocks.readStatus,
}));
vi.mock('@/server/compat/idempotency', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimIdempotencyKey: mocks.claim,
  settleIdempotencyKey: mocks.settle,
  releaseIdempotencyKey: mocks.release,
}));

const openaiRoute = {
  protocol: 'openai' as const,
  name: 'chat.completions' as const,
  parse: parseOpenAIChatRequest,
  createResponder: createOpenAIResponder,
};
const anthropicRoute = {
  protocol: 'anthropic' as const,
  name: 'messages' as const,
  validateHeaders: validateAnthropicHeaders,
  parse: parseAnthropicMessagesRequest,
  createResponder: createAnthropicResponder,
};

function request(body: unknown, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  const req: any = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = {
    host: 'daedalus.lan',
    'x-forwarded-proto': 'https',
    authorization: 'Bearer dkey_test',
    'content-length': String(Buffer.byteLength(raw)),
    ...headers,
  };
  return req;
}

function response() {
  const res: any = new EventEmitter();
  Object.assign(res, {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined as any,
    chunks: [] as string[],
    writableEnded: false,
    destroyed: false,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = String(value);
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
  });
  return res;
}

const principal = {
  username: 'alice',
  userId: 'alice-id',
  name: 'Alice',
  keyId: '0123456789abcdef',
};

const chat = (extra: Record<string, unknown> = {}) => ({
  model: 'daedalus',
  messages: [
    { role: 'system', content: 'Answer tersely.' },
    { role: 'user', content: 'What time is it?' },
  ],
  ...extra,
});

beforeEach(() => {
  process.env.DAEDALUS_COMPAT_API_ENABLED = 'true';
  delete process.env.DAEDALUS_PUBLIC_URL;
  mocks.authenticate.mockResolvedValue(principal);
  mocks.rate.mockResolvedValue({
    allowed: true,
    remaining: 1,
    retryAfterSeconds: 0,
  });
  mocks.submit.mockImplementation(async (_principal, input) => ({
    jobId: input.jobId,
    status: 'pending',
  }));
  mocks.wait.mockResolvedValue({ kind: 'completed', text: 'It is noon.' });
  mocks.cancel.mockResolvedValue({ outcome: 'cancelled', canceled: true });
  mocks.claim.mockResolvedValue({ kind: 'claimed' });
  mocks.settle.mockResolvedValue(undefined);
  mocks.release.mockResolvedValue(undefined);
  mocks.readStatus.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete process.env.DAEDALUS_COMPAT_API_ENABLED;
  delete process.env.DAEDALUS_COMPAT_MODEL_ENABLED;
});

describe('compatibility chat execution', () => {
  it.each(['chat.completions', 'responses'] as const)(
    'preserves caller controls, verified history and returned tool calls for direct %s',
    async (name) => {
      process.env.DAEDALUS_COMPAT_MODEL_ENABLED = 'true';
      const { parseResponsesRequest } = await import(
        '@/server/compat/responsesRequest'
      );
      const { createResponsesResponder } = await import(
        '@/server/compat/responders'
      );
      const route =
        name === 'responses'
          ? {
              protocol: 'openai' as const,
              name,
              parse: parseResponsesRequest,
              createResponder: createResponsesResponder,
            }
          : openaiRoute;
      const schema = {
        type: 'object',
        properties: { fact: { type: 'string' } },
        required: ['fact'],
        additionalProperties: false,
      };
      const fn = { name: 'record_fact', parameters: schema, strict: true };
      const history = [
        { role: 'system', content: 'Preserve verified history facts.' },
        {
          role: 'assistant',
          content: 'The verified identifier is A-17.',
          tool_calls: [
            {
              id: 'call_old',
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_old', content: '{"fact":"A-17"}' },
        { role: 'user', content: 'Record the verified fact.' },
      ];
      const body =
        name === 'responses'
          ? {
              model: 'daedalus-model',
              input: [
                history[0],
                {
                  type: 'function_call',
                  call_id: 'call_old',
                  name: 'lookup',
                  arguments: '{}',
                },
                {
                  type: 'function_call_output',
                  call_id: 'call_old',
                  output: '{"fact":"A-17"}',
                },
                history[3],
              ],
              tools: [{ type: 'function', ...fn }],
              tool_choice: { type: 'function', name: fn.name },
              text: {
                format: {
                  type: 'json_schema',
                  name: 'fact',
                  strict: true,
                  schema,
                },
              },
              max_output_tokens: 32,
            }
          : {
              model: 'daedalus-model',
              messages: history,
              tools: [{ type: 'function', function: fn }],
              tool_choice: { type: 'function', function: { name: fn.name } },
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'fact', strict: true, schema },
              },
              max_completion_tokens: 32,
            };
      const output =
        name === 'responses'
          ? {
              output: [
                {
                  type: 'function_call',
                  call_id: 'call_new',
                  name: fn.name,
                  arguments: '{"fact":"A-17"}',
                },
              ],
              status: 'completed',
            }
          : {
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_new',
                        type: 'function',
                        function: {
                          name: fn.name,
                          arguments: '{"fact":"A-17"}',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            };
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(output), {
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const res = response();
      await handleCompatChat(
        request(body, { 'x-user-id': 'mallory' }),
        res,
        route,
      );
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(body);
      expect(fetchMock.mock.calls[0][1].headers['x-user-id']).toBe('alice');
      expect(fetchMock.mock.calls[0][1].headers.authorization).toBeUndefined();
      expect(fetchMock.mock.calls[0][0]).toContain(
        `/internal/model/${
          name === 'responses' ? 'responses' : 'chat/completions'
        }`,
      );
      expect(JSON.parse(res.chunks.join(''))).toEqual(output);
      expect(res.headers['x-daedalus-ignored-parameters']).toBeUndefined();
      expect(mocks.submit).not.toHaveBeenCalled();
    },
  );

  it('relays direct model SSE exactly, including tool arguments and length termination', async () => {
    process.env.DAEDALUS_COMPAT_MODEL_ENABLED = 'true';
    const wire =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(wire, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );
    const res = response();
    await handleCompatChat(
      request(
        chat({
          model: 'daedalus-model',
          stream: true,
          max_completion_tokens: 1,
        }),
      ),
      res,
      openaiRoute,
    );
    expect(res.chunks.join('')).toBe(wire);
    expect(res.writableEnded).toBe(true);
  });

  it('never falls back to the agent for a disabled or incompatible direct request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const disabled = response();
    await handleCompatChat(
      request(chat({ model: 'daedalus-model' })),
      disabled,
      openaiRoute,
    );
    expect(disabled.statusCode).toBe(404);
    process.env.DAEDALUS_COMPAT_MODEL_ENABLED = 'true';
    for (const header of ['x-daedalus-conversation-id', 'idempotency-key']) {
      const res = response();
      await handleCompatChat(
        request(chat({ model: 'daedalus-model' }), { [header]: 'saved' }),
        res,
        openaiRoute,
      );
      expect(res.statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('cancels direct inference when its client disconnects', async () => {
    process.env.DAEDALUS_COMPAT_MODEL_ENABLED = 'true';
    const res = response();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url, options) => {
        signal = options.signal;
        res.destroyed = true;
        res.emit('close');
        throw new Error('aborted');
      }),
    );
    await handleCompatChat(
      request(chat({ model: 'daedalus-model' })),
      res,
      openaiRoute,
    );
    expect(signal?.aborted).toBe(true);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
  });

  it('returns model rejection without running the agent or claiming success', async () => {
    process.env.DAEDALUS_COMPAT_MODEL_ENABLED = 'true';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: 'Configured model endpoint ignored request controls',
            },
          }),
          { status: 502 },
        ),
      ),
    );
    const res = response();
    await handleCompatChat(
      request(chat({ model: 'daedalus-model' })),
      res,
      openaiRoute,
    );
    expect(res.statusCode).toBe(502);
    expect(res.body.error.message).toContain('ignored request controls');
    expect(res.headers['x-should-retry']).toBe('false');
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'advertises the direct model only when enabled (%s) and only to OpenAI',
    async (enabled) => {
      process.env.DAEDALUS_COMPAT_MODEL_ENABLED = String(enabled);
      const { default: models } = await import('@/pages/api/v1/models');
      for (const anthropic of [false, true]) {
        const req = request(
          {},
          anthropic ? { 'anthropic-version': '2023-06-01' } : {},
        );
        req.method = 'GET';
        const res = response();
        await models(req, res);
        expect(res.body.data.map((model: { id: string }) => model.id)).toEqual(
          enabled && !anthropic ? ['daedalus', 'daedalus-model'] : ['daedalus'],
        );
      }
    },
  );
  it('answers 404 while the operator switch is off', async () => {
    delete process.env.DAEDALUS_COMPAT_API_ENABLED;
    const res = response();
    await handleCompatChat(request(chat()), res, openaiRoute);
    expect(res.statusCode).toBe(404);
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it('runs an isolated final-answer job as the key owner, ignoring forged identity headers', async () => {
    const res = response();
    await handleCompatChat(
      request(chat({ temperature: 0.1 }), {
        'x-user-id': 'mallory',
        'x-daedalus-internal-token': 'forged',
        'x-daedalus-execution-scope': 'autonomy',
      }),
      res,
      openaiRoute,
    );
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    const [submittedPrincipal, input] = mocks.submit.mock.calls[0];
    expect(submittedPrincipal).toEqual({
      username: 'alice',
      userId: 'alice-id',
      name: 'Alice',
    });
    expect(input).toMatchObject({
      additionalProps: null,
      conversationId: null,
      callerInstructions: 'Answer tersely.',
      responseMode: 'final_only',
      api: { protocol: 'openai', persistence: 'isolated' },
      messages: [{ role: 'user', content: 'What time is it?' }],
    });
    expect(input.messages[0].id).toEqual(expect.any(String));
    expect(res.statusCode).toBe(200);
    expect(res.body.choices[0].message.content).toBe('It is noon.');
    expect(res.headers['x-daedalus-run-id']).toBe(input.jobId);
    expect(res.headers['x-request-id']).toBe(input.jobId);
    expect(res.headers['x-daedalus-ignored-parameters']).toBe('temperature');
    expect(res.headers['x-daedalus-conversation-id']).toBeUndefined();
  });

  it('rejects invalid input and bad keys before any job exists', async () => {
    const unsupported = response();
    await handleCompatChat(
      request(chat({ messages: [{ role: 'invalid', content: 'x' }] })),
      unsupported,
      openaiRoute,
    );
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.headers['x-should-retry']).toBe('false');

    const { CompatError } = await import('@/server/compat/errors');
    mocks.authenticate.mockRejectedValueOnce(
      new CompatError('authentication', 'Invalid API key.'),
    );
    const unauthenticated = response();
    await handleCompatChat(request(chat()), unauthenticated, openaiRoute);
    expect(unauthenticated.statusCode).toBe(401);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('applies the shared per-user rate limit before reading the body', async () => {
    mocks.rate.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 12,
    });
    const res = response();
    await handleCompatChat(request(chat()), res, anthropicRoute);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('12');
    expect(res.headers['x-should-retry']).toBe('true');
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('continues a named conversation with only the new user turn', async () => {
    const res = response();
    await handleCompatChat(
      request(
        chat({
          messages: [
            { role: 'user', content: 'Earlier' },
            { role: 'assistant', content: 'Earlier answer' },
            { role: 'user', content: 'Next question' },
          ],
        }),
        { 'x-daedalus-conversation-id': 'conv-1' },
      ),
      res,
      openaiRoute,
    );
    const input = mocks.submit.mock.calls[0][1];
    expect(input.conversationId).toBe('conv-1');
    expect(input.api.persistence).toBe('conversation');
    expect(input.messages.map((m: any) => m.content)).toEqual([
      'Next question',
    ]);
    expect(res.headers['x-daedalus-conversation-id']).toBe('conv-1');

    const invalid = response();
    await handleCompatChat(
      request(chat(), { 'x-daedalus-conversation-id': '../x' }),
      invalid,
      openaiRoute,
    );
    expect(invalid.statusCode).toBe(400);
  });

  it.each([
    [
      new ApiRouteError(429, 'Five chats running', 'active_chat_limit'),
      429,
      'true',
    ],
    [new ApiRouteError(409, 'Busy', 'conversation_job_active'), 409, 'true'],
    [new ApiRouteError(503, 'Expired', 'submission_expired'), 503, 'true'],
    [new ApiRouteError(503, 'Unknown', 'submission_unconfirmed'), 502, 'false'],
    [new ConversationWriteError('forbidden'), 404, 'false'],
  ])('maps submission failure %s', async (error, status, retry) => {
    mocks.submit.mockRejectedValueOnce(error);
    const res = response();
    await handleCompatChat(
      request(chat(), { 'x-daedalus-conversation-id': 'conv-2' }),
      res,
      openaiRoute,
    );
    expect(res.statusCode).toBe(status);
    expect(res.headers['x-should-retry']).toBe(retry);
    expect(mocks.wait).not.toHaveBeenCalled();
  });

  it('returns an approval requirement with a browser link and conversation', async () => {
    mocks.wait.mockResolvedValueOnce({
      kind: 'approval_required',
      conversationId: 'api-run',
      summary: 'Update document doc-1',
    });
    const res = response();
    await handleCompatChat(request(chat()), res, openaiRoute);
    expect(res.statusCode).toBe(403);
    expect(res.headers['x-should-retry']).toBe('false');
    expect(res.body.error.code).toBe('approval_required');
    expect(res.body.error.message).toContain('Update document doc-1');
    expect(res.body.error.daedalus).toMatchObject({
      conversation_id: 'api-run',
      action_url: 'https://daedalus.lan/?conversation=api-run',
      requirement: 'mcp_approval',
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('stops a run waiting for OAuth and points to the web app', async () => {
    mocks.wait.mockResolvedValueOnce({
      kind: 'oauth_required',
      service: 'calendar',
    });
    const res = response();
    await handleCompatChat(
      request(anthropic(), { 'anthropic-version': '2023-06-01' }),
      res,
      anthropicRoute,
    );
    const runId = mocks.submit.mock.calls[0][1].jobId;
    expect(mocks.cancel).toHaveBeenCalledWith('alice', runId);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.type).toBe('permission_error');
    expect(res.body.error.message).toContain('Google Calendar');
    expect(res.body.error.daedalus.action_url).toBe(
      'https://daedalus.lan/?view=connections',
    );
  });

  it('never reports a failed run as a completion', async () => {
    mocks.wait.mockResolvedValueOnce({
      kind: 'failed',
      message: 'Backend stream failed: Agent run timed out',
    });
    const res = response();
    await handleCompatChat(request(chat({ stream: true })), res, openaiRoute);
    const text = res.chunks.join('');
    expect(text).toContain('"error"');
    expect(text).toContain('Agent run timed out');
    expect(text).not.toContain('[DONE]');
    expect(text).not.toContain('"finish_reason":"stop"');
  });

  it('streams a budgeted answer with the protocol truncation reason', async () => {
    mocks.wait.mockResolvedValueOnce({
      kind: 'completed',
      text: 'abcdefghijkl',
    });
    const res = response();
    await handleCompatChat(
      request(anthropic({ max_tokens: 2, stream: true }), {
        'anthropic-version': '2023-06-01',
      }),
      res,
      anthropicRoute,
    );
    const text = res.chunks.join('');
    expect(text).toContain('"text":"abcdefgh"');
    expect(text).toContain('"stop_reason":"max_tokens"');
    expect(text).toContain('event: message_stop');
  });

  it('stops the run when the client disconnects and writes nothing more', async () => {
    let release!: (value: unknown) => void;
    mocks.wait.mockImplementationOnce(
      (_jobId: string, options: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          release = resolve;
          options.signal.addEventListener('abort', () =>
            reject(options.signal.reason),
          );
        }),
    );
    const res = response();
    const done = handleCompatChat(
      request(chat({ stream: true })),
      res,
      openaiRoute,
    );
    await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalled());
    const before = res.chunks.length;
    res.emit('close');
    await done;
    const runId = mocks.submit.mock.calls[0][1].jobId;
    expect(mocks.cancel).toHaveBeenCalledWith('alice', runId);
    expect(res.chunks.length).toBe(before);
    release(undefined);
  });

  describe('Idempotency-Key', () => {
    it('rejects a reused key with a different request', async () => {
      mocks.claim.mockResolvedValueOnce({ kind: 'mismatch', record: {} });
      const res = response();
      await handleCompatChat(
        request(chat(), { 'idempotency-key': 'k1' }),
        res,
        openaiRoute,
      );
      expect(res.statusCode).toBe(409);
      expect(res.body.error.code).toBe('idempotency_key_reused');
      expect(mocks.submit).not.toHaveBeenCalled();
    });

    it('replays a retained completion without running again', async () => {
      mocks.claim.mockResolvedValueOnce({
        kind: 'existing',
        record: {
          version: 1,
          jobId: 'run-old',
          requestHash: 'h',
          state: 'completed',
          createdAt: 1,
          outcome: { kind: 'completed', text: 'Retained', truncated: false },
        },
      });
      const res = response();
      await handleCompatChat(
        request(chat(), { 'idempotency-key': 'k2' }),
        res,
        openaiRoute,
      );
      expect(mocks.submit).not.toHaveBeenCalled();
      expect(mocks.wait).not.toHaveBeenCalled();
      expect(res.body.choices[0].message.content).toBe('Retained');
      expect(res.body.id).toBe('chatcmpl-run-old');
      expect(res.headers['x-daedalus-run-id']).toBe('run-old');
      expect(res.headers['x-daedalus-idempotent-replay']).toBe('true');
    });

    it('attaches to an active run instead of starting another', async () => {
      mocks.claim.mockResolvedValueOnce({
        kind: 'existing',
        record: {
          version: 1,
          jobId: 'run-active',
          requestHash: 'h',
          state: 'running',
          createdAt: 1,
        },
      });
      const res = response();
      await handleCompatChat(
        request(chat(), { 'idempotency-key': 'k3' }),
        res,
        openaiRoute,
      );
      expect(mocks.submit).not.toHaveBeenCalled();
      expect(mocks.wait.mock.calls[0][0]).toBe('run-active');
      expect(res.body.choices[0].message.content).toBe('It is noon.');
      expect(res.body.id).toBe('chatcmpl-run-active');
    });

    it('never replays a run whose start is uncertain', async () => {
      mocks.claim.mockResolvedValueOnce({
        kind: 'existing',
        record: {
          version: 1,
          jobId: 'run-unknown',
          requestHash: 'h',
          state: 'uncertain',
          createdAt: 1,
        },
      });
      const res = response();
      await handleCompatChat(
        request(chat(), { 'idempotency-key': 'k4' }),
        res,
        openaiRoute,
      );
      expect(res.statusCode).toBe(409);
      expect(res.body.error.code).toBe('idempotency_outcome_unknown');
      expect(mocks.submit).not.toHaveBeenCalled();
    });

    it('releases the key when admission rejects the run and records outcomes', async () => {
      mocks.submit.mockRejectedValueOnce(
        new ApiRouteError(429, 'Five chats running', 'active_chat_limit'),
      );
      await handleCompatChat(
        request(chat(), { 'idempotency-key': 'k5' }),
        response(),
        openaiRoute,
      );
      expect(mocks.release).toHaveBeenCalledWith(
        'alice',
        'chat.completions',
        'k5',
        expect.any(String),
      );

      mocks.submit.mockRejectedValueOnce(
        new ApiRouteError(503, 'Unknown', 'submission_unconfirmed'),
      );
      await handleCompatChat(
        request(chat(), { 'idempotency-key': 'k6' }),
        response(),
        openaiRoute,
      );
      expect(mocks.settle).toHaveBeenLastCalledWith(
        'alice',
        'chat.completions',
        'k6',
        expect.any(String),
        'uncertain',
      );

      await handleCompatChat(
        request(chat(), { 'idempotency-key': 'k7' }),
        response(),
        openaiRoute,
      );
      expect(mocks.settle).toHaveBeenLastCalledWith(
        'alice',
        'chat.completions',
        'k7',
        expect.any(String),
        'completed',
        { kind: 'completed', text: 'It is noon.', truncated: false },
      );
    });
  });
});

function anthropic(extra: Record<string, unknown> = {}) {
  return {
    model: 'daedalus',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'What is on my calendar?' }],
    ...extra,
  };
}

describe('Responses route and cache-only admission', () => {
  it('uses the actual Responses handler and drops external state before queueing', async () => {
    const { default: handler } = await import('@/pages/api/v1/responses');
    const res = response();
    await handler(
      request({
        model: 'gpt-4o',
        input: 'Hello',
        instructions: 'Be brief',
        previous_response_id: 'external',
        conversation: 'external',
        background: true,
        tools: [{ type: 'mcp', server_url: 'https://external.invalid' }],
      }),
      res,
    );
    expect(res.body.object).toBe('response');
    expect(res.body.output[0].content[0].text).toBe('It is noon.');
    expect(res.headers['x-daedalus-ignored-parameters']).toContain(
      'previous_response_id',
    );
    expect(mocks.submit).toHaveBeenCalledOnce();
    const input = mocks.submit.mock.calls[0][1];
    expect(input.conversationId).toBeNull();
    expect(input.callerInstructions).toBe('Be brief');
    expect(input.responseMode).toBe('final_only');
    expect(JSON.stringify(input)).not.toContain('external');
    expect(input.messages.map((m: { content: string }) => m.content)).toEqual([
      'Hello',
    ]);
  });

  it('keeps Responses disabled with the operator switch', async () => {
    delete process.env.DAEDALUS_COMPAT_API_ENABLED;
    const { default: handler } = await import('@/pages/api/v1/responses');
    const res = response();
    await handler(request({ input: 'Hello' }), res);
    expect(res.statusCode).toBe(404);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'does not run tools for Anthropic max_tokens: 0 (stream=%s)',
    async (stream) => {
      const res = response();
      await handleCompatChat(
        request({
          model: 'daedalus',
          max_tokens: 0,
          messages: [{ role: 'user', content: 'Do something' }],
          stream,
        }),
        res,
        anthropicRoute,
      );
      expect(res.statusCode).toBe(200);
      expect(mocks.authenticate).toHaveBeenCalledOnce();
      expect(mocks.submit).not.toHaveBeenCalled();
      expect(mocks.wait).not.toHaveBeenCalled();
      if (stream) expect(res.chunks.join('')).toContain('message_stop');
      else expect(res.body.content).toEqual([]);
    },
  );
});
