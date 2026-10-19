import {
  appendStreamResponseDelta,
  appendStreamSteps,
  clearStreamState,
  getStreamResponse,
  getStreamSteps,
  streamResponseKey,
  streamStepsKey,
} from '@/server/chat/streamState';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  del: vi.fn(),
  eval: vi.fn(),
  evalsha: vi.fn(),
  get: vi.fn(),
  lrange: vi.fn(),
  // Redis's script cache: digests of bodies it has evaluated.
  cached: new Set<string>(),
}));

const sha1 = (source: string) =>
  createHash('sha1').update(source).digest('hex');

vi.mock('@/server/session/redis', () => ({
  getRedis: vi.fn(() => mocks),
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
}));

describe('normalized live stream state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.del.mockResolvedValue(0);
    mocks.cached.clear();
    mocks.eval.mockImplementation(async (script: string) => {
      mocks.cached.add(sha1(script));
      return 1;
    });
    mocks.evalsha.mockImplementation(async (sha: string) => {
      if (!mocks.cached.has(sha))
        throw new Error('NOSCRIPT No matching script. Please use EVAL.');
      return 1;
    });
    mocks.get.mockResolvedValue(null);
    mocks.lrange.mockResolvedValue([]);
  });

  it('appends only the new response delta and refreshes its TTL atomically', async () => {
    await appendStreamResponseDelta('job-1', 'next bytes', 0);
    await appendStreamResponseDelta('job-1', '', 10);

    expect(mocks.eval).toHaveBeenCalledTimes(1);
    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('APPEND'"),
      1,
      'daedalus:async-job-response:job-1',
      'next bytes',
      3600,
      0,
    );
  });

  it('sends a per-flush script body only until Redis has cached it', async () => {
    await appendStreamResponseDelta('job-1', 'first', 0);
    await appendStreamResponseDelta('job-1', 'second', 5);
    await appendStreamResponseDelta('job-1', 'third', 11);

    // The first flush finds no cached script and sends the body once; later
    // flushes send only its digest.
    expect(mocks.eval).toHaveBeenCalledTimes(1);
    expect(mocks.evalsha).toHaveBeenCalledTimes(3);
    const [sha, keys, key, delta, , offset] = mocks.evalsha.mock.calls[2];
    expect(sha).toBe(sha1(mocks.eval.mock.calls[0][0]));
    expect([keys, key, delta, offset]).toEqual([
      1,
      'daedalus:async-job-response:job-1',
      'third',
      11,
    ]);
  });

  it('does not resend a script after a failure other than a cache miss', async () => {
    mocks.evalsha.mockRejectedValueOnce(
      new Error('stream response offset gap'),
    );

    await expect(appendStreamResponseDelta('job-1', 'gap', 99)).rejects.toThrow(
      'offset gap',
    );
    expect(mocks.eval).not.toHaveBeenCalled();
  });

  it('pushes only newly observed steps in one bounded write', async () => {
    const steps = [{ id: 1 }, { id: 2, payload: { event_type: 'TOOL_END' } }];

    await appendStreamSteps('job-2', steps, 0);

    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('RPUSH'"),
      1,
      'daedalus:async-job-steps-v2:job-2',
      3600,
      0,
      JSON.stringify(steps[0]),
      JSON.stringify(steps[1]),
    );
  });

  it('reads normalized response and step state', async () => {
    mocks.get.mockResolvedValue('assembled response');
    mocks.lrange.mockResolvedValue([
      JSON.stringify({ id: 1 }),
      'invalid-json',
      JSON.stringify({ id: 2 }),
    ]);

    await expect(getStreamResponse('job-3', 'legacy')).resolves.toBe(
      'assembled response',
    );
    await expect(
      getStreamSteps('job-3', [{ id: 'fallback' }]),
    ).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('uses the status snapshot for empty normalized state with one read each', async () => {
    const snapshotSteps = [{ id: 'snapshot' }];

    await expect(getStreamResponse('job-4', 'snapshot response')).resolves.toBe(
      'snapshot response',
    );
    await expect(getStreamSteps('job-4', snapshotSteps)).resolves.toEqual(
      snapshotSteps,
    );
    // No job writes the retired async-job-steps JSON array, so an empty step
    // list costs no further Redis round trip.
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.lrange).toHaveBeenCalledTimes(1);
  });

  it('cleans the normalized keys in one delete', async () => {
    await clearStreamState('job-5');

    expect(mocks.del).toHaveBeenCalledOnce();
    expect(mocks.del).toHaveBeenCalledWith(
      streamResponseKey('job-5'),
      streamStepsKey('job-5'),
    );
  });

  it('does not turn failed durability reads into empty response or tool history', async () => {
    mocks.get.mockRejectedValue(new Error('Response read unavailable'));
    mocks.lrange.mockRejectedValue(new Error('Step read unavailable'));

    await expect(getStreamResponse('job-6')).rejects.toThrow(
      'Response read unavailable',
    );
    await expect(getStreamSteps('job-6')).rejects.toThrow(
      'Step read unavailable',
    );
  });
});
