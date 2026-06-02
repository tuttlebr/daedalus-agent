import {
  clearSessionCookie,
  getOrSetSessionId,
  readSessionId,
  rotateSessionId,
} from '@/server/session/_utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// _utils imports getSession from the session module (for requireAuthenticatedUser),
// which would pull in the full Redis/ioredis chain. Stub it so we can unit-test
// the cookie helpers in isolation.
vi.mock('@/utils/auth/session', () => ({
  getSession: vi.fn(),
}));

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeReqRes(
  cookieHeader?: string,
  extraHeaders: Record<string, string> = {},
) {
  const req = {
    headers: { cookie: cookieHeader, ...extraHeaders },
    connection: {},
    socket: {},
  } as any;
  const setHeader = vi.fn();
  const res = { setHeader } as any;
  return { req, res, setHeader };
}

function getSetCookie(setHeader: ReturnType<typeof vi.fn>): string | undefined {
  const call = setHeader.mock.calls.find((c) => c[0] === 'Set-Cookie');
  return call?.[1] as string | undefined;
}

describe('server/session/_utils session cookie helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('FORCE_SECURE_COOKIES', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reuses an existing sid without setting a new cookie', () => {
    const { req, res, setHeader } = makeReqRes('sid=existing-123');
    expect(getOrSetSessionId(req, res)).toBe('existing-123');
    expect(getSetCookie(setHeader)).toBeUndefined();
  });

  it('mints and sets a hardened cookie when no sid is present', () => {
    const { req, res, setHeader } = makeReqRes(undefined);
    const sid = getOrSetSessionId(req, res);
    expect(sid).toMatch(UUID_RE);
    const cookie = getSetCookie(setHeader);
    expect(cookie).toContain(`sid=${sid}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie?.toLowerCase()).toContain('samesite=strict');
    expect(cookie).toContain('Max-Age=604800');
  });

  it('rotateSessionId mints a NEW sid on login and reports the previous one (fixation fix)', () => {
    const { req, res, setHeader } = makeReqRes('sid=attacker-fixed-sid');
    const { sid, previousSid } = rotateSessionId(req, res);
    expect(previousSid).toBe('attacker-fixed-sid');
    expect(sid).not.toBe('attacker-fixed-sid');
    expect(sid).toMatch(UUID_RE);
    expect(getSetCookie(setHeader)).toContain(`sid=${sid}`);
  });

  it('rotateSessionId reports no previous sid when the client had none', () => {
    const { req, res } = makeReqRes(undefined);
    const { sid, previousSid } = rotateSessionId(req, res);
    expect(previousSid).toBeUndefined();
    expect(sid).toMatch(UUID_RE);
  });

  it('clearSessionCookie expires the cookie', () => {
    const { req, res, setHeader } = makeReqRes('sid=old-abc');
    clearSessionCookie(req, res);
    expect(getSetCookie(setHeader)).toContain('Max-Age=0');
  });

  it('marks the cookie Secure behind an HTTPS proxy', () => {
    const { req, res, setHeader } = makeReqRes(undefined, {
      'x-forwarded-proto': 'https',
    });
    getOrSetSessionId(req, res);
    expect(getSetCookie(setHeader)).toContain('Secure');
  });

  it('readSessionId returns undefined when no cookie is present', () => {
    const { req } = makeReqRes(undefined);
    expect(readSessionId(req)).toBeUndefined();
  });
});
