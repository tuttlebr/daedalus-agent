import { createSession, destroySession } from '@/utils/auth/session';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rotateSessionId: vi.fn(),
  readSessionId: vi.fn(),
  clearSessionCookie: vi.fn(),
  getOrSetSessionId: vi.fn(),
  getRedis: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  jsonGet: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@/server/session/_utils', () => ({
  rotateSessionId: mocks.rotateSessionId,
  readSessionId: mocks.readSessionId,
  clearSessionCookie: mocks.clearSessionCookie,
  getOrSetSessionId: mocks.getOrSetSessionId,
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: mocks.getRedis,
  sessionKey: (parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
  jsonSetWithExpiry: mocks.jsonSetWithExpiry,
  jsonGet: mocks.jsonGet,
}));

const SESSION_EXPIRY = 60 * 60 * 24;
const req = {} as any;
const res = {} as any;
const user = { id: '1', username: 'admin', name: 'Admin', createdAt: 1 } as any;

describe('utils/auth/session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRedis.mockReturnValue({ del: mocks.del });
    mocks.del.mockResolvedValue(1);
    mocks.jsonSetWithExpiry.mockResolvedValue(undefined);
  });

  it('createSession rotates the sid and stores the session under the new id', async () => {
    mocks.rotateSessionId.mockReturnValue({
      sid: 'new-sid',
      previousSid: 'old-sid',
    });

    const sid = await createSession(req, res, user);

    expect(mocks.rotateSessionId).toHaveBeenCalledWith(req, res);
    expect(sid).toBe('new-sid');
    expect(mocks.jsonSetWithExpiry).toHaveBeenCalledWith(
      'auth-session:new-sid',
      expect.objectContaining({ username: 'admin', userId: '1' }),
      SESSION_EXPIRY,
    );
    // The pre-login session record is deleted so a fixed sid cannot be reused.
    expect(mocks.del).toHaveBeenCalledWith('auth-session:old-sid');
  });

  it('createSession does not delete anything when there was no prior sid', async () => {
    mocks.rotateSessionId.mockReturnValue({
      sid: 'fresh',
      previousSid: undefined,
    });

    await createSession(req, res, user);

    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('destroySession deletes the session record and clears the cookie', async () => {
    mocks.readSessionId.mockReturnValue('abc');

    await destroySession(req, res);

    expect(mocks.del).toHaveBeenCalledWith('auth-session:abc');
    expect(mocks.clearSessionCookie).toHaveBeenCalledWith(req, res);
  });

  it('destroySession still clears the cookie when no sid is present', async () => {
    mocks.readSessionId.mockReturnValue(undefined);

    await destroySession(req, res);

    expect(mocks.del).not.toHaveBeenCalled();
    expect(mocks.clearSessionCookie).toHaveBeenCalledWith(req, res);
  });
});
