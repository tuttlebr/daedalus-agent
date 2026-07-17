import {
  appendStreamResponseDelta,
  appendStreamSteps,
  clearStreamState,
  getStreamResponse,
  getStreamSteps,
  legacyStreamStepsKey,
  streamResponseKey,
  streamStepsKey,
} from '@/server/chat/streamState';
import { jsonDel, jsonGet } from '@/server/session/redis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  del: vi.fn(),
  eval: vi.fn(),
  get: vi.fn(),
  lrange: vi.fn(),
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: vi.fn(() => mocks),
  jsonDel: vi.fn(),
  jsonGet: vi.fn(),
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
}));

describe('normalized live stream state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.del.mockResolvedValue(0);
    mocks.eval.mockResolvedValue(1);
    mocks.get.mockResolvedValue(null);
    mocks.lrange.mockResolvedValue([]);
    (jsonDel as any).mockResolvedValue(0);
    (jsonGet as any).mockResolvedValue(null);
  });

  it('appends only the new response delta and refreshes its TTL atomically', async () => {
    await appendStreamResponseDelta('job-1', 'next bytes');
    await appendStreamResponseDelta('job-1', '');

    expect(mocks.eval).toHaveBeenCalledTimes(1);
    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('APPEND'"),
      1,
      'daedalus:async-job-response:job-1',
      'next bytes',
      3600,
    );
  });

  it('pushes only newly observed steps in one bounded write', async () => {
    const steps = [{ id: 1 }, { id: 2, payload: { event_type: 'TOOL_END' } }];

    await appendStreamSteps('job-2', steps);

    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('RPUSH'"),
      1,
      'daedalus:async-job-steps-v2:job-2',
      3600,
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

  it('falls back to legacy snapshots during a rolling upgrade', async () => {
    const legacySteps = [{ id: 'legacy' }];
    (jsonGet as any).mockResolvedValue(legacySteps);

    await expect(getStreamResponse('job-4', 'legacy response')).resolves.toBe(
      'legacy response',
    );
    await expect(getStreamSteps('job-4', [])).resolves.toEqual(legacySteps);
    expect(jsonGet).toHaveBeenCalledWith('daedalus:async-job-steps:job-4');
  });

  it('cleans normalized and legacy keys together', async () => {
    await clearStreamState('job-5');

    expect(mocks.del).toHaveBeenCalledWith(
      streamResponseKey('job-5'),
      streamStepsKey('job-5'),
    );
    expect(jsonDel).toHaveBeenCalledWith(legacyStreamStepsKey('job-5'));
  });
});
