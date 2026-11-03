import {
  IMAGE_JOB_LEASE_MS,
  heartbeatImageJob,
} from '@/server/images/jobRecovery';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateJsonAtomically: vi.fn(),
}));

vi.mock('@/server/atomicJson', () => ({
  updateJsonAtomically: mocks.updateJsonAtomically,
}));
vi.mock('@/server/session/redis', () => ({
  jsonGet: vi.fn(),
  sessionKey: (parts: string[]) => parts.join(':'),
}));

const BEAT_MS = IMAGE_JOB_LEASE_MS / 4;

describe('heartbeatImageJob', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.updateJsonAtomically.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a renewal that failed to reach Redis while the lease is valid', async () => {
    const onLost = vi.fn();
    mocks.updateJsonAtomically
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue({ jobId: 'job', status: 'running' });
    const stop = heartbeatImageJob('job', onLost);

    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(mocks.updateJsonAtomically).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(mocks.updateJsonAtomically).toHaveBeenCalledTimes(2);
    expect(onLost).not.toHaveBeenCalled();
    stop();
  });

  it('reports loss once the lease window elapses without a renewal', async () => {
    const onLost = vi.fn();
    mocks.updateJsonAtomically.mockRejectedValue(new Error('ECONNRESET'));
    const stop = heartbeatImageJob('job', onLost);

    await vi.advanceTimersByTimeAsync(IMAGE_JOB_LEASE_MS - BEAT_MS);
    expect(onLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost.mock.calls[0][0].message).toBe('ECONNRESET');
    stop();
  });

  it('reports loss at once when the renewal finds another owner', async () => {
    const onLost = vi.fn();
    mocks.updateJsonAtomically.mockResolvedValue(null);
    const stop = heartbeatImageJob('job', onLost);

    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost.mock.calls[0][0].message).toBe(
      'Image execution lease was lost',
    );
    stop();
  });

  it('extends the validity window with each successful renewal', async () => {
    const onLost = vi.fn();
    mocks.updateJsonAtomically
      .mockResolvedValueOnce({ jobId: 'job', status: 'running' })
      .mockResolvedValueOnce({ jobId: 'job', status: 'running' })
      .mockRejectedValue(new Error('ECONNRESET'));
    const stop = heartbeatImageJob('job', onLost);

    // Two renewals at 15 s and 30 s; the window now ends at 30 s + 60 s.
    await vi.advanceTimersByTimeAsync(2 * BEAT_MS);
    // Failures at 45, 60, 75 s stay inside the window.
    await vi.advanceTimersByTimeAsync(3 * BEAT_MS);
    expect(onLost).not.toHaveBeenCalled();
    // 90 s reaches the window's end.
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(onLost).toHaveBeenCalledTimes(1);
    stop();
  });
});
