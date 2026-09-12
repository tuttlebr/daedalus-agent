import {
  checkRateLimit,
  enforceRateLimit,
  ruleFromEnv,
} from '@/server/rateLimit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ increment: vi.fn() }));

vi.mock('@/server/redisCounter', () => ({
  incrementExpiringCounter: mocks.increment,
}));

vi.mock('@/server/session/redis', () => ({
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
  });

  it('uses the atomic counter contract and allows the first hit', async () => {
    mocks.increment.mockResolvedValue([1, 60]);
    const result = await checkRateLimit(rule, 'user-a');
    expect(mocks.increment).toHaveBeenCalledWith(
      expect.stringMatching(/^ratelimit:test:[a-f0-9]{32}$/),
      60,
    );
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it('allows a subsequent hit within the limit', async () => {
    mocks.increment.mockResolvedValue([2, 42]);
    const result = await checkRateLimit(rule, 'user-a');
    expect(result.allowed).toBe(true);
  });

  it('blocks once the count exceeds the limit and reports retryAfter', async () => {
    mocks.increment.mockResolvedValue([4, 42]);
    const result = await checkRateLimit(rule, 'user-a');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(42);
  });

  it('enforceRateLimit allows and does not respond when under the limit', async () => {
    mocks.increment.mockResolvedValue([1, 60]);
    const res = makeRes();
    const ok = await enforceRateLimit(res, rule, 'user-a');
    expect(ok).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('enforceRateLimit responds 429 with Retry-After when exceeded', async () => {
    mocks.increment.mockResolvedValue([99, 30]);
    const res = makeRes();
    const ok = await enforceRateLimit(res, rule, 'user-a');
    expect(ok).toBe(false);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('fails open (allows the request) when the limiter backend errors', async () => {
    mocks.increment.mockRejectedValue(new Error('redis down'));
    const res = makeRes();
    const ok = await enforceRateLimit(res, rule, 'user-a');
    expect(ok).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns a positive Retry-After when Redis reports the last fractional second', async () => {
    mocks.increment.mockResolvedValue([4, 0]);
    const res = makeRes();
    expect(await enforceRateLimit(res, rule, 'user-a')).toBe(false);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
  });

  it('ruleFromEnv reads limit/window overrides from env', () => {
    vi.stubEnv('RATE_LIMIT_X_MAX', '7');
    vi.stubEnv('RATE_LIMIT_X_WINDOW_SECONDS', '120');
    const r = ruleFromEnv('x', 'RATE_LIMIT_X', 40, 60);
    expect(r).toEqual({ name: 'x', limit: 7, windowSeconds: 120 });
    vi.unstubAllEnvs();
  });
});
