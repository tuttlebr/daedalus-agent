import { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey, jsonGet, jsonSetWithExpiry } from '@/pages/api/session/redis';
import { getOrSetSessionId } from '@/pages/api/session/_utils';
import { User } from './users';
import { setIdentityCookie, clearIdentityCookie } from './identity-cookie';

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
  await jsonSetWithExpiry(key, sessionData, SESSION_EXPIRY);

  // Set signed identity cookie for Edge-compatible verification (e.g. /api/chat)
  const isSecure = req.headers['x-forwarded-proto'] === 'https' ||
                   (req.connection as any)?.encrypted ||
                   process.env.FORCE_SECURE_COOKIES === 'true' ||
                   process.env.NODE_ENV === 'production';
  setIdentityCookie(res, user, isSecure);

  return sessionId;
}

// Get session data
export async function getSession(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<SessionData | null> {
  const sessionId = getOrSetSessionId(req, res);
  const key = sessionKey(['auth-session', sessionId]);

  const session = await jsonGet(key) as SessionData | null;
  if (!session) return null;

  // Update last activity
  session.lastActivity = Date.now();
  await jsonSetWithExpiry(key, session, SESSION_EXPIRY);

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

  // Clear the signed identity cookie
  clearIdentityCookie(res);
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
