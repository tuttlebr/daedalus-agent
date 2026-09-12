import {
  createSession,
  destroySession,
  getSession,
} from '@/utils/auth/session';

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
  eval: vi.fn(),
  isConfiguredUsername: vi.fn(),
}));

vi.mock('@/utils/auth/config', () => ({
  isConfiguredUsername: mocks.isConfiguredUsername,
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
    mocks.getRedis.mockReturnValue({ del: mocks.del, eval: mocks.eval });
    mocks.isConfiguredUsername.mockReturnValue(true);
    mocks.getOrSetSessionId.mockReturnValue('active-sid');
    mocks.del.mockResolvedValue(1);
    mocks.jsonSetWithExpiry.mockResolvedValue(undefined);
  });

  it.each([0, 60_001])(
    'revokes an unconfigured account before any refresh when activity is %sms old',
    async (elapsed) => {
      mocks.jsonGet.mockResolvedValue({
        username: 'removed',
        lastActivity: Date.now() - elapsed,
      });
      mocks.isConfiguredUsername.mockReturnValue(false);
      expect(await getSession(req, res)).toBeNull();
      expect(mocks.del).toHaveBeenCalledWith('auth-session:active-sid');
      expect(mocks.eval).not.toHaveBeenCalled();
      expect(mocks.clearSessionCookie).toHaveBeenCalledWith(req, res);
    },
  );

  it('continues sliding a configured session', async () => {
    const session = { username: 'admin', lastActivity: Date.now() - 60_001 };
    mocks.jsonGet.mockResolvedValue(session);
    mocks.eval.mockResolvedValue(JSON.stringify(session));
    expect(await getSession(req, res)).toEqual(session);
    expect(mocks.isConfiguredUsername).toHaveBeenCalledWith('admin');
    expect(mocks.eval).toHaveBeenCalledOnce();
    expect(mocks.del).not.toHaveBeenCalled();
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
