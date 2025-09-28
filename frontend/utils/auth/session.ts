import { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey } from '@/pages/api/session/redis';
import { getOrSetSessionId } from '@/pages/api/session/_utils';
import { User } from './users';

const SESSION_EXPIRY = 60 * 60 * 24; // 24 hours

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
  user: Omit<User, 'passwordHash'>
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
  await redis.setex(key, SESSION_EXPIRY, JSON.stringify(sessionData));

  return sessionId;
}

// Get session data
export async function getSession(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<SessionData | null> {
  const redis = getRedis();
  const sessionId = getOrSetSessionId(req, res);

  const key = sessionKey(['auth-session', sessionId]);
  const data = await redis.get(key);

  if (!data) return null;

  const session = JSON.parse(data) as SessionData;

  // Update last activity
  session.lastActivity = Date.now();
  await redis.setex(key, SESSION_EXPIRY, JSON.stringify(session));

  return session;
}

// Check if user is authenticated
export async function isAuthenticated(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<boolean> {
  const session = await getSession(req, res);
  return session !== null;
}

// Destroy session
export async function destroySession(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<void> {
  const redis = getRedis();
  const sessionId = getOrSetSessionId(req, res);

  const key = sessionKey(['auth-session', sessionId]);
  await redis.del(key);
}

// Middleware to protect API routes
export function requireAuth(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const authenticated = await isAuthenticated(req, res);

    if (!authenticated) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return handler(req, res);
  };
}
