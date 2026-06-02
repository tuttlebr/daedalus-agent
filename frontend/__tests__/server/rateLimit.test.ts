import {
  checkRateLimit,
  enforceRateLimit,
  ruleFromEnv,
} from '@/server/rateLimit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRedis: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  ttl: vi.fn(),
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: mocks.getRedis,
  sessionKey: (parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
}));

const rule = { name: 'test', limit: 3, windowSeconds: 60 };

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
}

describe('server/rateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRedis.mockReturnValue({
      incr: mocks.incr,
      expire: mocks.expire,
      ttl: mocks.ttl,
    });
  });

  it('sets the window TTL on the first hit and allows it', async () => {
    mocks.incr.mockResolvedValue(1);
    const result = await checkRateLimit(rule, 'user-a');
    expect(mocks.expire).toHaveBeenCalledWith(expect.any(String), 60);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it('does not reset the TTL on subsequent hits within the limit', async () => {
    mocks.incr.mockResolvedValue(2);
    const result = await checkRateLimit(rule, 'user-a');
    expect(mocks.expire).not.toHaveBeenCalled();
    expect(result.allowed).toBe(true);
  });

  it('blocks once the count exceeds the limit and reports retryAfter', async () => {
    mocks.incr.mockResolvedValue(4);
    mocks.ttl.mockResolvedValue(42);
    const result = await checkRateLimit(rule, 'user-a');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(42);
  });

  it('enforceRateLimit allows and does not respond when under the limit', async () => {
    mocks.incr.mockResolvedValue(1);
    const res = makeRes();
    const ok = await enforceRateLimit(res, rule, 'user-a');
    expect(ok).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('enforceRateLimit responds 429 with Retry-After when exceeded', async () => {
    mocks.incr.mockResolvedValue(99);
    mocks.ttl.mockResolvedValue(30);
    const res = makeRes();
    const ok = await enforceRateLimit(res, rule, 'user-a');
    expect(ok).toBe(false);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('fails open (allows the request) when the limiter backend errors', async () => {
    mocks.incr.mockRejectedValue(new Error('redis down'));
    const res = makeRes();
    const ok = await enforceRateLimit(res, rule, 'user-a');
    expect(ok).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('ruleFromEnv reads limit/window overrides from env', () => {
    vi.stubEnv('RATE_LIMIT_X_MAX', '7');
    vi.stubEnv('RATE_LIMIT_X_WINDOW_SECONDS', '120');
    const r = ruleFromEnv('x', 'RATE_LIMIT_X', 40, 60);
    expect(r).toEqual({ name: 'x', limit: 7, windowSeconds: 120 });
    vi.unstubAllEnvs();
  });
});
