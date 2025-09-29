import type { NextApiRequest, NextApiResponse } from 'next';
import cookie from 'cookie';
import { randomUUID } from 'crypto';
import { getSession } from '@/utils/auth/session';

const COOKIE_NAME = 'sid';

export function getOrSetSessionId(req: NextApiRequest, res: NextApiResponse): string {
  const cookies = cookie.parse(req.headers.cookie || '');
  let sid = cookies[COOKIE_NAME];
  if (!sid) {
    sid = randomUUID();
    // Only use secure cookies if explicitly running on HTTPS
    // Check for HTTPS via x-forwarded-proto header (common in proxies) or protocol
    const isSecure = req.headers['x-forwarded-proto'] === 'https' ||
                     (req.connection as any)?.encrypted ||
                     process.env.FORCE_SECURE_COOKIES === 'true';

    res.setHeader('Set-Cookie', cookie.serialize(COOKIE_NAME, sid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure,
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    }));
  }
  return sid;
}

export async function getUserId(req: NextApiRequest, res: NextApiResponse): Promise<string> {
  // Try to get user ID from authenticated session first
  const session = await getSession(req, res);

  if (session && session.username) {
    return session.username;
  }

  // Fallback to header (for backwards compatibility) or 'anon'
  const userId = (req.headers['x-user-id'] as string) || 'anon';
  return userId;
}
