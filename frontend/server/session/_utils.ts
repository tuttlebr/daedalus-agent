import type { NextApiRequest, NextApiResponse } from 'next';

import { getSession } from '@/utils/auth/session';
import type { SessionData } from '@/utils/auth/session';

import cookie from 'cookie';
import { randomUUID } from 'crypto';

const COOKIE_NAME = 'sid';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

// SECURITY: Ensure secure cookies in production/HTTPS environments. Detect
// HTTPS via x-forwarded-proto (set by the nginx proxy), the socket, or an
// explicit override.
function isSecureRequest(req: NextApiRequest): boolean {
  return (
    req.headers['x-forwarded-proto'] === 'https' ||
    Boolean((req.connection as any)?.encrypted) ||
    process.env.FORCE_SECURE_COOKIES === 'true' ||
    process.env.NODE_ENV === 'production'
  );
}

// SECURITY: HttpOnly prevents JavaScript access (XSS), SameSite=strict adds
// CSRF protection, Secure ensures HTTPS-only transmission. A maxAge of 0
// expires the cookie (used on logout).
function writeSessionCookie(
  req: NextApiRequest,
  res: NextApiResponse,
  sid: string,
  maxAge: number,
): void {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(COOKIE_NAME, sid, {
      httpOnly: true,
      sameSite: 'strict',
      secure: isSecureRequest(req),
      path: '/',
      maxAge,
    }),
  );
}

// Read the current sid from the request cookies without minting a new one.
export function readSessionId(req: NextApiRequest): string | undefined {
  return cookie.parse(req.headers.cookie || '')[COOKIE_NAME];
}

export function getOrSetSessionId(
  req: NextApiRequest,
  res: NextApiResponse,
): string {
  let sid = readSessionId(req);
  if (!sid) {
    sid = randomUUID();
    writeSessionCookie(req, res, sid, COOKIE_MAX_AGE_SECONDS);
  }
  return sid;
}

// SECURITY (session fixation): mint a brand-new sid and overwrite the cookie.
// Call this on any privilege change (i.e. successful login) so a pre-auth or
// client-supplied sid is never promoted into an authenticated session. Returns
// the new sid plus the previous one (if any) so the caller can delete the now
// orphaned session record.
export function rotateSessionId(
  req: NextApiRequest,
  res: NextApiResponse,
): { sid: string; previousSid?: string } {
  const previousSid = readSessionId(req);
  const sid = randomUUID();
  writeSessionCookie(req, res, sid, COOKIE_MAX_AGE_SECONDS);
  return { sid, previousSid };
}

// Expire the sid cookie in the browser. Pair with deleting the server-side
// session record on logout so a stale cookie cannot be reused.
export function clearSessionCookie(
  req: NextApiRequest,
  res: NextApiResponse,
): void {
  writeSessionCookie(req, res, '', 0);
}

export async function requireAuthenticatedUser(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<SessionData | null> {
  const session = await getSession(req, res);
  if (!session?.username) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }

  return session;
}
