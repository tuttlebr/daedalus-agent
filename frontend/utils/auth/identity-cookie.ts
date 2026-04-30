/**
 * Signed identity cookie — Node.js runtime functions.
 *
 * The session (sid) cookie is verified server-side against Redis, which works
 * in Node.js API routes but NOT in Edge API routes (Edge can't use ioredis).
 * This signed cookie provides a Redis-free way to verify user identity in Edge
 * routes like /api/chat.
 *
 * Lifecycle: set during login (Node.js), verified during chat (Edge),
 * cleared during logout (Node.js).
 *
 * Edge-compatible verification lives in identity-cookie-edge.ts to keep
 * Node.js-only imports (crypto, cookie) out of the Edge bundle.
 */
import type { NextApiResponse } from 'next';
import cookie from 'cookie';
import crypto from 'crypto';

export { type IdentityPayload } from './identity-cookie-edge';

const COOKIE_NAME = '__identity';
const COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours (matches session TTL)
const DEV_IDENTITY_SECRET = 'daedalus-dev-identity-secret';

function getIdentitySecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required in production');
  }

  return DEV_IDENTITY_SECRET;
}

/**
 * Set a signed identity cookie (Node.js runtime — called from createSession).
 * Appends to existing Set-Cookie headers so the session cookie isn't clobbered.
 */
export function setIdentityCookie(
  res: NextApiResponse,
  user: { id: string; username: string; name: string },
  isSecure: boolean,
): void {
  const secret = getIdentitySecret();

  const payload = {
    username: user.username,
    userId: user.id,
    name: user.name,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('hex');
  const cookieValue = `${encodedPayload}.${signature}`;

  // Append to existing Set-Cookie headers (don't clobber the sid cookie)
  const existing = res.getHeader('Set-Cookie');
  const cookies: string[] = Array.isArray(existing)
    ? [...existing]
    : existing
      ? [String(existing)]
      : [];

  cookies.push(
    cookie.serialize(COOKIE_NAME, cookieValue, {
      httpOnly: true,
      sameSite: 'strict',
      secure: isSecure,
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    }),
  );

  res.setHeader('Set-Cookie', cookies);
}

/**
 * Clear the identity cookie (Node.js runtime — called from destroySession).
 */
export function clearIdentityCookie(res: NextApiResponse): void {
  const existing = res.getHeader('Set-Cookie');
  const cookies: string[] = Array.isArray(existing)
    ? [...existing]
    : existing
      ? [String(existing)]
      : [];

  cookies.push(
    cookie.serialize(COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 0,
    }),
  );

  res.setHeader('Set-Cookie', cookies);
}
