import {
  buildMemoryRetentionSubmission,
  enqueueMemoryRetention,
  getMemoryRetentionHealth,
  processDueMemoryRetentions,
} from '@/server/chat/memoryRetention';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const values = new Map<string, any>();
  const sorted = new Map<string, Map<string, number>>();
  const fetchWithTimeout = vi.fn();
  const redis = {
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      const set = sorted.get(key) || new Map<string, number>();
      set.set(member, Number(score));
      sorted.set(key, set);
      return 1;
    }),
    expire: vi.fn(async () => 1),
    zremrangebyrank: vi.fn(async () => 0),
    zrem: vi.fn(async (key: string, member: string) => {
      sorted.get(key)?.delete(member);
      return 1;
    }),
    zrangebyscore: vi.fn(
      async (key: string, _minimum: number, maximum: number) =>
        Array.from(sorted.get(key)?.entries() || [])
          .filter(([, score]) => score <= Number(maximum))
          .sort((left, right) => left[1] - right[1])
          .map(([member]) => member),
    ),
    zrevrange: vi.fn(async (key: string) =>
      Array.from(sorted.get(key)?.entries() || [])
        .sort((left, right) => right[1] - left[1])
        .map(([member]) => member),
    ),
    set: vi.fn(async (key: string, value: string, ...options: any[]) => {
      if (options.includes('NX') && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => {
      const value = values.get(key);
      return typeof value === 'string' ? value : null;
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys) values.delete(key);
      return keys.length;
    }),
    eval: vi.fn(async (_script: string, _keys: number, key: string) => {
      values.delete(key);
      return 1;
    }),
  };
  return { values, sorted, fetchWithTimeout, redis };
});

vi.mock('@/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));
vi.mock('@/utils/app/backendApi', () => ({
  buildBackendBaseUrlForMode: () => 'http://backend.test',
  buildBackendUrlFromBase: (base: string, path: string) => `${base}${path}`,
}));
vi.mock('@/server/chat/natMessages', () => ({
  buildNatRequestHeaders: () => ({ Authorization: 'internal' }),
}));
vi.mock('@/server/session/redis', () => ({
  getRedis: () => mocks.redis,
  jsonGet: async (key: string) => mocks.values.get(key) || null,
  jsonSetWithExpiry: async (key: string, value: any) => {
    mocks.values.set(key, structuredClone(value));
  },
  sessionKey: (parts: string[]) => parts.filter(Boolean).join(':'),
}));

function trackedResponse(body: string, status: number) {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
      },
      cancel,
    }),
    { status },
  );
  return { response, cancel };
}

describe('durable memory retention polling', () => {
  beforeEach(() => {
    mocks.values.clear();
    mocks.sorted.clear();
    mocks.fetchWithTimeout.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases an unread error body and backs off before the next status poll', async () => {
    await enqueueMemoryRetention({
      jobId: 'job-unavailable',
      userId: 'alice',
      operationId: 'operation-unavailable',
      acceptedAt: Date.now() - 3000,
    });
    const unavailable = trackedResponse('<html>gateway</html>', 503);
    mocks.fetchWithTimeout.mockResolvedValueOnce(unavailable.response);

    await processDueMemoryRetentions();

    // fetchWithTimeout keeps its deadline and connection until the body is
    // consumed or cancelled.
    expect(unavailable.cancel).toHaveBeenCalled();
    await processDueMemoryRetentions();
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('settles every due job even when one of them fails', async () => {
    for (const jobId of ['job-fails', 'job-sibling']) {
      await enqueueMemoryRetention({
        jobId,
        userId: 'alice',
        operationId: `operation-${jobId}`,
        acceptedAt: Date.now() - 3000,
      });
    }
    const originalSet = mocks.redis.set.getMockImplementation()!;
    mocks.redis.set.mockImplementation((async (key: string, ...rest: any[]) => {
      if (key.includes('job-fails')) throw new Error('Redis lock failure');
      return (originalSet as any)(key, ...rest);
    }) as any);
    mocks.fetchWithTimeout.mockResolvedValue(
      new Response(JSON.stringify({ status: 'completed' }), { status: 200 }),
    );

    // The batch reports both jobs and the sibling's poll still ran.
    await expect(processDueMemoryRetentions()).resolves.toBe(2);
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(String(mocks.fetchWithTimeout.mock.calls[0][0])).toContain(
      'operation-job-sibling',
    );
    mocks.redis.set.mockImplementation(originalSet as any);
  });

  it('backs off instead of re-polling every loop when a status body is not JSON', async () => {
    await enqueueMemoryRetention({
      jobId: 'job-invalid',
      userId: 'alice',
      operationId: 'operation-invalid',
      acceptedAt: Date.now() - 3000,
    });
    mocks.fetchWithTimeout.mockResolvedValue(
      new Response('not json', { status: 200 }),
    );

    await expect(processDueMemoryRetentions()).resolves.toBe(1);
    vi.advanceTimersByTime(1000);
    await processDueMemoryRetentions();

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
    const health = await getMemoryRetentionHealth('alice');
    expect(health.recent[0]).toMatchObject({
      jobId: 'job-invalid',
      pollIndex: 1,
    });
  });

  it('classifies completed zero-fact extraction without retrying it', async () => {
    await enqueueMemoryRetention({
      jobId: 'job-zero',
      userId: 'alice',
      operationId: 'operation-zero',
      acceptedAt: Date.now() - 3000,
    });
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'zero_fact',
          unit_ids_count: 0,
          extraction_errors_count: 0,
        }),
        { status: 200 },
      ),
    );

    await processDueMemoryRetentions();
    const health = await getMemoryRetentionHealth('alice');

    expect(health.counts.zero_fact).toBe(1);
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWithTimeout.mock.calls[0][1].method).toBe('GET');
  });

  it('retries a failed operation once and then leaves a repeated failure terminal', async () => {
    await enqueueMemoryRetention({
      jobId: 'job-failed',
      userId: 'alice',
      operationId: 'operation-failed',
      acceptedAt: Date.now() - 3000,
    });
    mocks.fetchWithTimeout
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'failed', retry_count: 0 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'failed', retry_count: 1 }), {
          status: 200,
        }),
      );

    await processDueMemoryRetentions();
    vi.advanceTimersByTime(3000);
    await processDueMemoryRetentions();
    const health = await getMemoryRetentionHealth('alice');

    expect(health.counts.failed).toBe(1);
    expect(
      mocks.fetchWithTimeout.mock.calls.filter(
        (call) => call[1].method === 'POST',
      ),
    ).toHaveLength(1);
  });

  describe('queued submissions', () => {
    const turn = {
      jobId: 'job-turn',
      userId: 'alice',
      conversationId: 'conversation-1',
      assistantMessageId: 'answer-1',
      messages: [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
        {
          role: 'user',
          content:
            'Remember my build server is atlas [IDENTITY] internal\n![x](data:image/png;base64,AAAA)',
        },
      ],
      content: 'Noted: your build server is atlas.',
    };

    // The finalization journal write stores the submission and queues it.
    function queue(submission: NonNullable<ReturnType<typeof build>>) {
      mocks.values.set(submission.key, submission.value);
      void mocks.redis.zadd(submission.queueKey, submission.dueAt, turn.jobId);
    }
    const build = () =>
      buildMemoryRetentionSubmission({ ...turn, createdAt: Date.now() });

    it('sends the latest user turn once, then polls the accepted operation', async () => {
      const submission = build()!;
      // Pollers from earlier versions drop poll-queue entries that have no
      // accepted record, so submissions wait in their own queue.
      expect(submission.queueKey).toBe('memory-retention:submission-queue:v1');
      queue(submission);
      mocks.fetchWithTimeout.mockResolvedValueOnce(
        new Response(JSON.stringify({ operation_id: 'operation-turn' }), {
          status: 200,
        }),
      );

      await processDueMemoryRetentions();
      expect(
        mocks.sorted
          .get('memory-retention:submission-queue:v1')
          ?.has('job-turn'),
      ).toBe(false);

      expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
      const [url, request] = mocks.fetchWithTimeout.mock.calls[0];
      expect(url).toBe('http://backend.test/v1/memory/retain-turn');
      expect(JSON.parse(request.body)).toEqual({
        request_id: 'job-turn',
        conversation_id: 'conversation-1',
        assistant_message_id: 'answer-1',
        // Only the latest user message, without identity or inline data.
        user_content: 'Remember my build server is atlas',
        assistant_content: 'Noted: your build server is atlas.',
      });
      // The turn text is dropped once the operation is recorded.
      expect(mocks.values.has(submission.key)).toBe(false);
      expect(await getMemoryRetentionHealth('alice')).toMatchObject({
        total: 1,
        counts: { accepted: 1 },
      });

      mocks.fetchWithTimeout.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'completed' }), { status: 200 }),
      );
      vi.advanceTimersByTime(2_000);
      await processDueMemoryRetentions();
      expect(mocks.fetchWithTimeout.mock.calls[1][1].method).toBe('GET');
      expect((await getMemoryRetentionHealth('alice')).counts.completed).toBe(
        1,
      );
    });

    it('retries an unavailable memory service with backoff and the same request', async () => {
      const submission = build()!;
      queue(submission);
      const unavailable = trackedResponse('<html>gateway</html>', 502);
      mocks.fetchWithTimeout.mockResolvedValueOnce(unavailable.response);

      await processDueMemoryRetentions();
      expect(unavailable.cancel).toHaveBeenCalled();
      // Not yet due again: no tight retry loop.
      await processDueMemoryRetentions();
      expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
      expect(JSON.parse(mocks.values.get(submission.key))).toMatchObject({
        attempts: 1,
      });

      mocks.fetchWithTimeout.mockResolvedValueOnce(
        new Response(JSON.stringify({ operation_id: 'operation-retry' }), {
          status: 200,
        }),
      );
      vi.advanceTimersByTime(2_000);
      await processDueMemoryRetentions();
      expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2);
      expect(mocks.fetchWithTimeout.mock.calls[1][1].body).toBe(
        mocks.fetchWithTimeout.mock.calls[0][1].body,
      );
      expect(mocks.values.has(submission.key)).toBe(false);
    });

    it('drops a submission that could not be sent before the retention deadline', async () => {
      const submission = build()!;
      queue(submission);
      vi.advanceTimersByTime(30 * 60 * 1000);

      await processDueMemoryRetentions();

      expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
      expect(mocks.values.has(submission.key)).toBe(false);
      expect((await getMemoryRetentionHealth('alice')).total).toBe(0);
    });

    it('queues nothing for an approval prompt or a turn without user text', () => {
      expect(
        buildMemoryRetentionSubmission({
          ...turn,
          messages: [{ role: 'assistant', content: 'only' }],
          createdAt: 1,
        }),
      ).toBeNull();
      expect(
        buildMemoryRetentionSubmission({
          ...turn,
          content: `<!--daedalus-mcp-approval:${Buffer.from(
            JSON.stringify({
              version: 1,
              requestId: 'approval_request_12345',
              serverName: 'docs_mcp_server',
              toolName: 'update_doc',
              target: 'doc-1',
              summary: 'Update Google document doc-1',
              argumentsSha256: 'a'.repeat(64),
            }),
          ).toString('base64url')}-->`,
          createdAt: 1,
        }),
      ).toBeNull();
    });

    it.each([503, 404, 422])(
      'stops at once when the backend rejects a turn with %s',
      async (status) => {
        // 503 is the runtime's answer when memory is not enabled.
        const submission = build()!;
        queue(submission);
        mocks.fetchWithTimeout.mockResolvedValue(
          new Response('{"detail":"no"}', { status }),
        );

        await processDueMemoryRetentions();
        vi.advanceTimersByTime(60_000);
        await processDueMemoryRetentions();

        expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
        expect(mocks.values.has(submission.key)).toBe(false);
      },
    );

    it('gives up after a bounded number of transient failures', async () => {
      const submission = build()!;
      queue(submission);
      mocks.fetchWithTimeout.mockImplementation(async () => {
        throw new TypeError('fetch failed');
      });

      for (let poll = 0; poll < 12; poll += 1) {
        await processDueMemoryRetentions();
        vi.advanceTimersByTime(60_000);
      }

      expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(6);
      expect(mocks.values.has(submission.key)).toBe(false);
    });
  });
});
