// @vitest-environment node
import { applyStreamingContentDelta } from '@/utils/app/streamingContent';

import { startBackgroundStreamReader } from '@/server/chat/streamReader';
import type { AsyncJobRequest } from '@/server/chat/types';
import { saveOAuthCallbackTarget } from '@/server/mcpOAuth';
import { jsonGet } from '@/server/session/redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const mocks = {
    response: '',
    steps: [] as any[],
    publish: vi.fn(),
    finalizeSuccess: vi.fn(),
    finalizeError: vi.fn(),
    markJobStreaming: vi.fn(),
    appendStreamResponseDelta: vi.fn(
      async (_jobId: string, delta: string, offset: number) => {
        expect(offset).toBe(Buffer.byteLength(mocks.response));
        mocks.response += delta;
      },
    ),
    appendStreamSteps: vi.fn(
      async (_jobId: string, steps: any[], offset: number) => {
        expect(offset).toBe(mocks.steps.length);
        mocks.steps.push(...steps);
      },
    ),
  };
  return mocks;
});

vi.mock('@/server/chat/streamState', () => ({
  appendStreamResponseDelta: mocks.appendStreamResponseDelta,
  appendStreamSteps: mocks.appendStreamSteps,
  clearStreamState: vi.fn(),
}));
vi.mock('@/server/chat/finalization', () => ({
  finalizeSuccess: mocks.finalizeSuccess,
  finalizeError: mocks.finalizeError,
}));
vi.mock('@/server/chat/jobState', () => ({
  abortKey: (jobId: string) => `async-job-abort:${jobId}`,
  markJobStreaming: mocks.markJobStreaming,
  recordOAuthJobRequest: vi.fn(async () => true),
}));
vi.mock('@/server/session/redis', () => ({
  getPublisher: () => ({ publish: mocks.publish }),
  jsonGet: vi.fn(async () => null),
  jsonSetWithExpiry: vi.fn(),
  sessionKey: (parts: string[]) => parts.join(':'),
}));
vi.mock('@/server/mcpOAuth', () => ({ saveOAuthCallbackTarget: vi.fn() }));

const jobRequest = {
  jobId: 'job-1',
  natBaseUrl: 'http://backend.test:8000',
  executionMode: 'stream',
  messages: [{ role: 'user', content: 'Check the cluster' }],
  userId: 'alice',
  conversationId: 'conv-1',
} as AsyncJobRequest;

const openBodies: Array<{ push(chunk: string | null): void }> = [];

/** A backend body whose chunks the test releases one at a time. */
function controlledBody() {
  const encoder = new TextEncoder();
  const queued: Array<string | null> = [];
  let wake: (() => void) | null = null;
  const read = vi.fn(async () => {
    while (queued.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    const next = queued.shift()!;
    return next === null
      ? { done: true, value: undefined }
      : { done: false, value: encoder.encode(next) };
  });
  const body = {
    push(chunk: string | null) {
      queued.push(chunk);
      wake?.();
      wake = null;
    },
    response: {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({ read, cancel: vi.fn(), releaseLock: vi.fn() }),
      },
    },
  };
  openBodies.push(body);
  return body;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

const step = (id: string, phase: 'Start' | 'Complete') =>
  `intermediate_data: ${JSON.stringify({
    id,
    parent_id: 'run-1',
    name: `Function ${phase}: kubectl`,
    payload: phase === 'Start' ? '{"verb":"get"}' : 'pods ready',
  })}\n\n`;

describe('backend stream reader persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    mocks.response = '';
    mocks.steps = [];
    mocks.appendStreamResponseDelta.mockClear();
    mocks.appendStreamSteps.mockClear();
    mocks.publish.mockReset().mockResolvedValue(1);
    mocks.finalizeSuccess.mockReset().mockResolvedValue(true);
    mocks.finalizeError.mockReset().mockResolvedValue(true);
    mocks.markJobStreaming.mockReset().mockResolvedValue(undefined);
    vi.mocked(jsonGet)
      .mockReset()
      .mockImplementation(async () => null);
  });

  afterEach(() => {
    // End any stream a failed assertion left waiting for its next chunk.
    for (const body of openBodies.splice(0)) body.push(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([false, true])(
    'keeps a backend error finish reason as a partial failure (terminal=%s)',
    async (terminal) => {
      const body = controlledBody();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => body.response),
      );
      const reading = startBackgroundStreamReader(
        'job-1',
        structuredClone(jobRequest),
        [],
        'alice',
      );
      body.push(
        'data: {"choices":[{"delta":{"content":"Partial answer"}}]}\n\n',
      );
      body.push(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {},
              finish_reason: 'error',
              daedalus_terminal: terminal,
            },
          ],
        })}\n\ndata: [DONE]\n\n`,
      );
      await reading;
      expect(mocks.finalizeSuccess).not.toHaveBeenCalled();
      expect(mocks.finalizeError).toHaveBeenCalledWith(
        'job-1',
        expect.anything(),
        'Backend stream reported an error',
        expect.objectContaining({ response: 'Partial answer' }),
      );
    },
  );

  it('persists throttled output when the backend goes quiet behind keepalive comments', async () => {
    const body = controlledBody();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => body.response),
    );
    const reading = startBackgroundStreamReader(
      'job-1',
      structuredClone(jobRequest),
      [],
      'alice',
    );

    body.push(
      'event: message\ndata: {"choices":[{"delta":{"content":"Let me check."}}]}\n\n',
    );
    body.push(step('call-1', 'Start'));
    await settle();
    vi.setSystemTime(1_000_100);
    // Inside the 750 ms throttle: buffered, but already published live.
    body.push(
      'event: message\ndata: {"choices":[{"delta":{"content":" Checking pods."}}]}\n\n',
    );
    body.push(step('call-1', 'Complete'));
    body.push(step('call-2', 'Start'));
    await settle();
    expect(mocks.response).toBe('Let me check.');
    expect(mocks.steps).toHaveLength(1);

    // A long tool call: Rust sends only content-free activity comments.
    vi.setSystemTime(1_015_100);
    body.push(': tool active\n\n');
    await settle();

    // Recovery polling and reclaim read Redis, not the live channel.
    expect(mocks.response).toBe('Let me check. Checking pods.');
    expect(
      mocks.steps.map((value) => [
        value.function_ancestry.node_id,
        value.payload.event_type,
      ]),
    ).toEqual([
      ['call-1', 'TOOL_START'],
      ['call-1', 'TOOL_END'],
      ['call-2', 'TOOL_START'],
    ]);

    body.push(
      'event: message\ndata: {"choices":[{"delta":{},"finish_reason":"stop","daedalus_terminal":true}]}\n\n',
    );
    await reading;
    expect(mocks.finalizeSuccess).toHaveBeenCalledWith(
      'job-1',
      expect.anything(),
      'Let me check. Checking pods.',
    );
    expect(mocks.finalizeError).not.toHaveBeenCalled();
  });

  it('does not write state for keepalive comments when nothing is buffered', async () => {
    const body = controlledBody();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => body.response),
    );
    const reading = startBackgroundStreamReader(
      'job-1',
      structuredClone(jobRequest),
      [],
      'alice',
    );
    body.push(': model active\n\n');
    await settle();
    vi.setSystemTime(1_015_000);
    body.push(': model active\n\n');
    await settle();
    // An empty append leaves the accumulated text unchanged, so assert the
    // persistence boundary itself: idle keepalives issue no state writes.
    expect(mocks.appendStreamResponseDelta).not.toHaveBeenCalled();
    expect(mocks.appendStreamSteps).not.toHaveBeenCalled();
    expect(mocks.response).toBe('');
    expect(mocks.steps).toEqual([]);

    body.push(
      'event: message\ndata: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n',
    );
    await reading;
    expect(mocks.finalizeSuccess).toHaveBeenCalledWith(
      'job-1',
      expect.anything(),
      'Done',
    );
  });

  // The backend waits for an OAuth callback inside the run. Its stream ending
  // ends that run, so a job awaiting OAuth must still get a terminal outcome.
  it.each([
    ['closes', null],
    ['completes', 'data: [DONE]\n\n'],
  ])(
    'finalizes a job awaiting OAuth when the backend stream %s',
    async (_ending, terminal) => {
      vi.mocked(jsonGet).mockImplementation(async (key: string) =>
        key === 'async-job-status:job-1'
          ? { jobId: 'job-1', status: 'oauth_required' }
          : null,
      );
      const body = controlledBody();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => body.response),
      );
      const reading = startBackgroundStreamReader(
        'job-1',
        structuredClone(jobRequest),
        [],
        'alice',
      );
      body.push(
        'event: oauth_required\ndata: {"auth_url":"https://accounts.google.com/auth","oauth_state":"state-1"}\n\n',
      );
      body.push(step('call-1', 'Start'));
      if (terminal) body.push(terminal);
      body.push(null);
      await reading;

      // The callback route binds the browser session to this owner.
      expect(saveOAuthCallbackTarget).toHaveBeenCalledWith(
        'state-1',
        'http://backend.test:8000',
        'job-1',
        'alice',
      );
      if (terminal) {
        expect(mocks.finalizeSuccess).toHaveBeenCalledWith(
          'job-1',
          expect.anything(),
          '',
        );
        expect(mocks.finalizeError).not.toHaveBeenCalled();
      } else {
        expect(mocks.finalizeSuccess).not.toHaveBeenCalled();
        expect(mocks.finalizeError).toHaveBeenCalledWith(
          'job-1',
          expect.anything(),
          'Backend response stream ended before completion',
          expect.objectContaining({ response: '' }),
        );
      }
    },
  );

  const delta = (content: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  const published = () =>
    mocks.publish.mock.calls.map(([, payload]) => JSON.parse(payload));

  it('publishes the first delta at once and coalesces later deltas within the interval', async () => {
    const body = controlledBody();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => body.response),
    );
    const reading = startBackgroundStreamReader(
      'job-1',
      structuredClone(jobRequest),
      [],
      'alice',
    );

    body.push(delta('Th'));
    await settle();
    // Time to first token is unchanged: the first delta is not held.
    expect(published()).toEqual([
      expect.objectContaining({
        type: 'chat_token',
        content: 'Th',
        responseStart: 0,
      }),
    ]);

    body.push(delta('e '));
    body.push(delta('pods'));
    body.push(delta(' are'));
    await settle();
    expect(published()).toHaveLength(1);
    // A quiet stream still delivers buffered text after one interval.
    await vi.advanceTimersByTimeAsync(25);
    expect(published()).toHaveLength(2);
    expect(published()[1]).toMatchObject({
      type: 'chat_token',
      content: 'e pods are',
      responseStart: 2,
    });

    vi.setSystemTime(Date.now() + 100);
    body.push(delta(' ready.'));
    body.push('data: [DONE]\n\n');
    await reading;

    const tokens = published().filter((event) => event.type === 'chat_token');
    expect(tokens.map((event) => event.content)).toEqual([
      'Th',
      'e pods are',
      ' ready.',
    ]);
    // The browser's delta application rebuilds the answer from the coalesced
    // deltas and their offsets, and ignores a replayed one.
    const rebuilt = [...tokens, tokens[1]].reduce(
      (text, event) =>
        applyStreamingContentDelta(text, event.content, event.responseStart),
      '',
    );
    expect(rebuilt).toBe('The pods are ready.');
    expect(mocks.finalizeSuccess).toHaveBeenCalledWith(
      'job-1',
      expect.anything(),
      'The pods are ready.',
    );
  });

  it('publishes buffered tokens before an intermediate step to keep stream order', async () => {
    const body = controlledBody();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => body.response),
    );
    const reading = startBackgroundStreamReader(
      'job-1',
      structuredClone(jobRequest),
      [],
      'alice',
    );
    body.push(delta('Checking'));
    body.push(delta(' now.'));
    body.push(step('call-1', 'Start'));
    body.push(delta(' Done.'));
    body.push('data: [DONE]\n\n');
    await reading;

    expect(
      published().map((event) =>
        event.type === 'chat_token'
          ? `token:${event.responseStart}:${event.content}`
          : event.type,
      ),
    ).toEqual([
      'token:0:Checking',
      'token:8: now.',
      'chat_intermediate_step',
      'token:13: Done.',
    ]);
  });

  it('keeps the backend run outcome but saves a fixed message for other error text', async () => {
    for (const [message, saved] of [
      [
        'Model request timed out',
        'Backend stream failed: Model request timed out',
      ],
      [
        'upstream 10.0.3.4:443 returned invalid_request_error: max_tokens',
        'Backend stream reported an error',
      ],
    ]) {
      mocks.finalizeError.mockClear();
      mocks.response = '';
      const body = controlledBody();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => body.response),
      );
      const reading = startBackgroundStreamReader(
        'job-1',
        structuredClone(jobRequest),
        [],
        'alice',
      );
      body.push(delta('Partial'));
      body.push(
        `event: error\ndata: ${JSON.stringify({ error: { message } })}\n\n`,
      );
      await reading;
      expect(mocks.finalizeError).toHaveBeenCalledWith(
        'job-1',
        expect.anything(),
        saved,
        expect.objectContaining({ response: 'Partial' }),
      );
    }
  });

  it('saves a fixed message when stream persistence fails with an internal error', async () => {
    mocks.markJobStreaming.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 10.0.7.2:6379'),
    );
    const body = controlledBody();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => body.response),
    );
    const reading = startBackgroundStreamReader(
      'job-1',
      structuredClone(jobRequest),
      [],
      'alice',
    );
    body.push(delta('Partial'));
    await reading;

    expect(mocks.finalizeError).toHaveBeenCalledWith(
      'job-1',
      expect.anything(),
      'The response could not be completed because of an internal error. Please try again.',
      expect.objectContaining({ response: 'Partial' }),
    );
  });

  it('saves a fixed message when the backend cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', {
          cause: new Error('connect ECONNREFUSED 10.0.2.61:8000'),
        });
      }),
    );
    await startBackgroundStreamReader(
      'job-1',
      structuredClone(jobRequest),
      [],
      'alice',
    );
    expect(mocks.finalizeError).toHaveBeenCalledWith(
      'job-1',
      expect.anything(),
      'The response service could not be reached. Please try again.',
      expect.anything(),
    );
  });
});
