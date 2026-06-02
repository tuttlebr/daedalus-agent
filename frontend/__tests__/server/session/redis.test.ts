import { jsonSetWithExpiry } from '@/server/session/redis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Track every ioredis instance the module constructs.
const created: any[] = [];

vi.mock('@/server/session/dns-cache', () => ({
  primeDns: vi.fn(),
  getCachedIp: vi.fn(() => null),
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    status = 'ready';
    // COMMAND INFO JSON.GET → non-null array so RedisJSON is treated as present.
    call = vi.fn().mockResolvedValue([['JSON.GET', -1, [], 0, 0, 0]]);
    eval = vi.fn().mockResolvedValue(1);
    set = vi.fn().mockResolvedValue('OK');
    expire = vi.fn().mockResolvedValue(1);
    del = vi.fn().mockResolvedValue(1);
    on = vi.fn();
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    constructor() {
      created.push(this);
    }
  }
  return { default: FakeRedis };
});

describe('server/session/redis jsonSetWithExpiry — H4 atomic TTL', () => {
  beforeEach(() => {
    // Clear call history but keep the default mock implementations.
    vi.clearAllMocks();
  });

  it('writes the value and TTL atomically via a single eval (no separate EXPIRE)', async () => {
    await jsonSetWithExpiry('mykey', { a: 1 }, 60);
    const client = created[0];

    expect(client.eval).toHaveBeenCalledTimes(1);
    const [, numKeys, key, payload, ttl] = client.eval.mock.calls[0];
    expect(numKeys).toBe(1);
    expect(key).toBe('mykey');
    expect(JSON.parse(payload)).toEqual({ a: 1 });
    expect(Number(ttl)).toBe(60);

    // The whole point of H4: never a separate, non-atomic EXPIRE that could fail
    // and leave a TTL-less key, and never a silent plaintext SET fallback here.
    expect(client.expire).not.toHaveBeenCalled();
    expect(client.set).not.toHaveBeenCalled();
  });

  it('propagates a non-wrongtype error without falling back to a non-atomic write', async () => {
    const client = created[0];
    client.eval.mockRejectedValueOnce(new Error('READONLY You cannot write'));

    await expect(jsonSetWithExpiry('k2', { b: 2 }, 30)).rejects.toThrow(
      'READONLY',
    );
    expect(client.set).not.toHaveBeenCalled();
    expect(client.expire).not.toHaveBeenCalled();
  });

  it('recovers from a wrongtype key by deleting and retrying the atomic write', async () => {
    const client = created[0];
    client.eval
      .mockRejectedValueOnce(
        new Error(
          'WRONGTYPE Operation against a key holding the wrong kind of value',
        ),
      )
      .mockResolvedValueOnce(1);

    await jsonSetWithExpiry('k3', { c: 3 }, 30);

    expect(client.del).toHaveBeenCalledWith('k3');
    expect(client.eval).toHaveBeenCalledTimes(2);
    expect(client.set).not.toHaveBeenCalled();
  });

  it('recovers from the RedisJSON "wrong Redis type" message (not just standard WRONGTYPE)', async () => {
    const client = created[0];
    client.eval
      .mockRejectedValueOnce(
        new Error(
          'Existing key has wrong Redis type script: abc123, on @user_script:1.',
        ),
      )
      .mockResolvedValueOnce(1);

    await jsonSetWithExpiry('k4', { d: 4 }, 30);

    expect(client.del).toHaveBeenCalledWith('k4');
    expect(client.eval).toHaveBeenCalledTimes(2);
  });
});
