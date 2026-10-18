import {
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
    set: vi.fn(async (key: string, value: string) => {
      if (values.has(key)) return null;
      values.set(key, value);
      return 'OK';
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
});
