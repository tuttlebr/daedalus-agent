import { NextApiRequest, NextApiResponse } from 'next';

import { User } from './users';

import { getOrSetSessionId } from '@/server/session/_utils';
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
  const redis = getRedis();
  const sessionId = getOrSetSessionId(req, res);

  const sessionData: SessionData = {
    userId: user.id,
    username: user.username,
    name: user.name,
    loginTime: Date.now(),
    lastActivity: Date.now(),
  };

  const key = sessionKey(['auth-session', sessionId]);
  await jsonSetWithExpiry(key, sessionData, SESSION_EXPIRY);

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
  const redis = getRedis();
  const sessionId = getOrSetSessionId(req, res);

  const key = sessionKey(['auth-session', sessionId]);
  await redis.del(key);
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
