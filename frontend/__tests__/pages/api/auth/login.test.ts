import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeUsers: vi.fn(),
  verifyCredentials: vi.fn(),
  createSession: vi.fn(),
  redisGet: vi.fn(),
  redisTtl: vi.fn(),
  redisIncr: vi.fn(),
  redisExpire: vi.fn(),
  redisDel: vi.fn(),
}));

vi.mock('@/utils/auth/users', () => ({
  initializeUsers: mocks.initializeUsers,
  verifyCredentials: mocks.verifyCredentials,
}));

vi.mock('@/utils/auth/session', () => ({
  createSession: mocks.createSession,
}));

vi.mock('@/pages/api/session/redis', () => ({
  getRedis: vi.fn(() => ({
    get: mocks.redisGet,
    ttl: mocks.redisTtl,
    incr: mocks.redisIncr,
    expire: mocks.redisExpire,
    del: mocks.redisDel,
  })),
  sessionKey: vi.fn((parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
  ),
}));

import handler from '@/pages/api/auth/login';

function createMockReqRes(
  body: Record<string, unknown>,
  method = 'POST',
) {
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
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisTtl.mockResolvedValue(-2);
    mocks.redisIncr.mockResolvedValue(1);
    mocks.redisExpire.mockResolvedValue(1);
    mocks.redisDel.mockResolvedValue(1);
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

    expect(mocks.verifyCredentials).toHaveBeenCalledWith('admin', 'correct');
    expect(mocks.createSession).toHaveBeenCalledWith(req, res, user);
    expect(mocks.redisDel).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, user });
  });

  it('records failed attempts on invalid credentials', async () => {
    mocks.verifyCredentials.mockResolvedValue(null);
    const { req, res } = createMockReqRes({
      username: 'admin',
      password: 'wrong',
    });

    await handler(req, res);

    expect(mocks.redisIncr).toHaveBeenCalledTimes(1);
    expect(mocks.redisExpire).toHaveBeenCalledWith(
      expect.any(String),
      300,
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects login while the username and IP are locked out', async () => {
    mocks.redisGet.mockResolvedValue('5');
    mocks.redisTtl.mockResolvedValue(123);
    const { req, res } = createMockReqRes({
      username: 'admin',
      password: 'correct',
    });

    await handler(req, res);

    expect(mocks.verifyCredentials).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Too many failed login attempts. Please try again later.',
      retryAfterSeconds: 123,
    });
  });
});
