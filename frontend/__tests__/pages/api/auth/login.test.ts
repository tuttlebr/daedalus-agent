import handler from '@/pages/api/auth/login';

import {
  confirmFailedAttempt,
  releaseLimitedAttempt,
  reserveLimitedAttempt,
} from '@/server/redisCounter';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeUsers: vi.fn(),
  verifyCredentials: vi.fn(),
  createSession: vi.fn(),
  redisDel: vi.fn(),
}));

// Real Redis atomicity is covered by login.integration.test.ts.
vi.mock('@/server/redisCounter', () => ({
  reserveLimitedAttempt: vi.fn(),
  confirmFailedAttempt: vi.fn(),
  releaseLimitedAttempt: vi.fn(),
}));

vi.mock('@/utils/auth/users', () => ({
  initializeUsers: mocks.initializeUsers,
  verifyCredentials: mocks.verifyCredentials,
}));

vi.mock('@/utils/auth/session', () => ({
  createSession: mocks.createSession,
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: vi.fn(() => ({ del: mocks.redisDel })),
  sessionKey: vi.fn((parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
  ),
}));

const scopes = [
  { key: expect.stringMatching(/^auth-login-attempts:pair:/), limit: 5 },
  { key: expect.stringMatching(/^auth-login-attempts:account:/), limit: 10 },
  { key: expect.stringMatching(/^auth-login-attempts:ip:/), limit: 30 },
];

function createMockReqRes(body: Record<string, unknown>, method = 'POST') {
  const req = {
    method,
    body,
    query: {},
    headers: {
      'x-forwarded-for': '203.0.113.10',
      'user-agent': 'vitest',
    },
    socket: { remoteAddress: '127.0.0.1' },
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
  return { req, res };
}

describe('/api/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initializeUsers.mockResolvedValue(undefined);
    mocks.createSession.mockResolvedValue('session-1');
    mocks.redisDel.mockResolvedValue(1);
    vi.mocked(reserveLimitedAttempt).mockResolvedValue(0);
    vi.mocked(confirmFailedAttempt).mockResolvedValue(undefined);
    vi.mocked(releaseLimitedAttempt).mockResolvedValue(undefined);
  });

  it('creates a session with sanitized user data and clears failed attempts', async () => {
    const user = {
      id: '1',
      username: 'admin',
      name: 'Admin',
      createdAt: 1700000000000,
    };
    mocks.verifyCredentials.mockResolvedValue(user);
    const { req, res } = createMockReqRes({
      username: ' admin ',
      password: 'correct',
    });

    await handler(req, res);

    expect(reserveLimitedAttempt).toHaveBeenCalledWith(scopes, 300, 900);
    expect(mocks.verifyCredentials).toHaveBeenCalledWith('admin', 'correct');
    expect(mocks.createSession).toHaveBeenCalledWith(req, res, user);
    expect(mocks.redisDel).toHaveBeenCalledWith(
      expect.stringMatching(/^auth-login-attempts:pair:/),
    );
    expect(releaseLimitedAttempt).toHaveBeenCalledWith([
      expect.stringMatching(/^auth-login-attempts:account:/),
      expect.stringMatching(/^auth-login-attempts:ip:/),
    ]);
    expect(confirmFailedAttempt).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, user });
  });

  it('keeps the reserved attempt as a failure on invalid credentials', async () => {
    mocks.verifyCredentials.mockResolvedValue(null);
    const { req, res } = createMockReqRes({
      username: 'admin',
      password: 'wrong',
    });

    await handler(req, res);

    expect(reserveLimitedAttempt).toHaveBeenCalledWith(scopes, 300, 900);
    expect(confirmFailedAttempt).toHaveBeenCalledWith(scopes, 900);
    expect(releaseLimitedAttempt).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns the reservation when credential verification fails unexpectedly', async () => {
    mocks.verifyCredentials.mockRejectedValue(new Error('bcrypt failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { req, res } = createMockReqRes({
      username: 'admin',
      password: 'correct',
    });

    await handler(req, res);

    expect(releaseLimitedAttempt).toHaveBeenCalledWith([
      expect.stringMatching(/^auth-login-attempts:pair:/),
      expect.stringMatching(/^auth-login-attempts:account:/),
      expect.stringMatching(/^auth-login-attempts:ip:/),
    ]);
    expect(confirmFailedAttempt).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('rejects login without verifying while any attempt counter is locked', async () => {
    vi.mocked(reserveLimitedAttempt).mockResolvedValue(123);
    const { req, res } = createMockReqRes({
      username: 'admin',
      password: 'correct',
    });

    await handler(req, res);

    expect(mocks.verifyCredentials).not.toHaveBeenCalled();
    expect(confirmFailedAttempt).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Too many failed login attempts. Please try again later.',
      retryAfterSeconds: 123,
    });
  });

  it('keys the address on the closest trusted proxy, not a forged left entry', async () => {
    mocks.verifyCredentials.mockResolvedValue(null);
    const first = createMockReqRes({ username: 'admin', password: 'x' });
    first.req.headers['x-forwarded-for'] = '10.0.0.1, 203.0.113.10';
    await handler(first.req, first.res);
    const second = createMockReqRes({ username: 'admin', password: 'x' });
    second.req.headers['x-forwarded-for'] = '10.9.9.9, 203.0.113.10';
    await handler(second.req, second.res);

    const [firstScopes, secondScopes] = vi
      .mocked(reserveLimitedAttempt)
      .mock.calls.map(([counters]) => counters.map(({ key }) => key));
    expect(secondScopes).toEqual(firstScopes);
  });
});
