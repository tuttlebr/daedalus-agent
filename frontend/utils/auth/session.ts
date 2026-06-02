import { NextApiRequest, NextApiResponse } from 'next';

import { User } from './users';

import {
  clearSessionCookie,
  getOrSetSessionId,
  readSessionId,
  rotateSessionId,
} from '@/server/session/_utils';
import {
  getRedis,
  sessionKey,
  jsonGet,
  jsonSetWithExpiry,
} from '@/server/session/redis';

const SESSION_EXPIRY = 60 * 60 * 24; // 24 hours
// Throttle the lastActivity/TTL write-back so we don't issue a Redis write on
// every authenticated request (F-015).
const ACTIVITY_REFRESH_INTERVAL_MS = 60_000;

export interface SessionData {
  userId: string;
  username: string;
  name: string;
  loginTime: number;
  lastActivity: number;
}

// Create a new session
export async function createSession(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Omit<User, 'passwordHash'>,
): Promise<string> {
  // SECURITY (session fixation): never reuse a pre-auth / client-supplied sid
  // as the authenticated session id. Mint a fresh sid and drop the old record.
  const { sid: sessionId, previousSid } = rotateSessionId(req, res);

  const sessionData: SessionData = {
    userId: user.id,
    username: user.username,
    name: user.name,
    loginTime: Date.now(),
    lastActivity: Date.now(),
  };

  const key = sessionKey(['auth-session', sessionId]);
  await jsonSetWithExpiry(key, sessionData, SESSION_EXPIRY);

  if (previousSid && previousSid !== sessionId) {
    await getRedis()
      .del(sessionKey(['auth-session', previousSid]))
      .catch(() => {});
  }

  return sessionId;
}

// Get session data
export async function getSession(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<SessionData | null> {
  const sessionId = getOrSetSessionId(req, res);
  const key = sessionKey(['auth-session', sessionId]);

  const session = (await jsonGet(key)) as SessionData | null;
  if (!session) return null;

  // Refresh lastActivity + sliding TTL at most once per interval rather than on
  // every request. With a 60s interval and 24h TTL the session still slides for
  // active users, but we avoid a Redis write on every authenticated call.
  const now = Date.now();
  if (now - (session.lastActivity || 0) > ACTIVITY_REFRESH_INTERVAL_MS) {
    session.lastActivity = now;
    await jsonSetWithExpiry(key, session, SESSION_EXPIRY);
  }

  return session;
}

// Check if user is authenticated
export async function isAuthenticated(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<boolean> {
  const session = await getSession(req, res);
  return session !== null;
}

// Destroy session
export async function destroySession(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<void> {
  const sessionId = readSessionId(req);
  if (sessionId) {
    await getRedis().del(sessionKey(['auth-session', sessionId]));
  }
  // Expire the cookie too, so the browser does not keep presenting a sid that a
  // subsequent login would otherwise rebind to a new session.
  clearSessionCookie(req, res);
}

// Middleware to protect API routes
export function requireAuth(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>,
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const authenticated = await isAuthenticated(req, res);

    if (!authenticated) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return handler(req, res);
  };
}
