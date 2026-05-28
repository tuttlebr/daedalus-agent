import { NextApiRequest, NextApiResponse } from 'next';

import { createSession } from '@/utils/auth/session';
import { verifyCredentials, initializeUsers } from '@/utils/auth/users';

import { getRedis, sessionKey } from '@/server/session/redis';
import { createHash } from 'crypto';

const LOGIN_WINDOW_SECONDS = Number(
  process.env.AUTH_LOGIN_WINDOW_SECONDS || 300,
);
const LOGIN_LOCKOUT_SECONDS = Number(
  process.env.AUTH_LOGIN_LOCKOUT_SECONDS || 900,
);
const LOGIN_MAX_ATTEMPTS = Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS || 5);

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function clientIp(req: NextApiRequest): string {
  const forwarded = firstHeaderValue(req.headers['x-forwarded-for']);
  return (
    forwarded.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'
  );
}

function loginAttemptKey(username: string, ip: string): string {
  const digest = createHash('sha256')
    .update(`${username.trim().toLowerCase()}|${ip}`)
    .digest('hex')
    .slice(0, 32);
  return sessionKey(['auth-login-attempts', digest]);
}

async function getLockoutSeconds(
  username: string,
  ip: string,
): Promise<number> {
  const redis = getRedis();
  const key = loginAttemptKey(username, ip);
  const attempts = Number((await redis.get(key)) || 0);
  if (attempts < LOGIN_MAX_ATTEMPTS) return 0;
  const ttl = await redis.ttl(key);
  return ttl > 0 ? ttl : LOGIN_LOCKOUT_SECONDS;
}

async function recordFailedLogin(username: string, ip: string): Promise<void> {
  const redis = getRedis();
  const key = loginAttemptKey(username, ip);
  const attempts = await redis.incr(key);
  if (attempts === 1) {
    await redis.expire(key, LOGIN_WINDOW_SECONDS);
  }
  if (attempts >= LOGIN_MAX_ATTEMPTS) {
    await redis.expire(key, LOGIN_LOCKOUT_SECONDS);
  }
}

async function clearFailedLogins(username: string, ip: string): Promise<void> {
  await getRedis().del(loginAttemptKey(username, ip));
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  // SECURITY: Explicitly reject GET requests with credential parameters
  if (req.method === 'GET') {
    const hasCredentials = req.query.username || req.query.password;
    if (hasCredentials) {
      // Log security event without exposing credentials
      console.warn(
        '[SECURITY] Attempted credential exposure via GET parameters',
        {
          ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
          userAgent: req.headers['user-agent'],
          timestamp: new Date().toISOString(),
        },
      );
      res.setHeader('Allow', ['POST']);
      return res.status(405).json({
        error:
          'Method not allowed. Credentials must be sent via POST request body.',
      });
    }
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // SECURITY: Additional check - reject if credentials are in query string even for POST
  if (req.query.username || req.query.password) {
    console.warn(
      '[SECURITY] Attempted credential exposure via query parameters in POST request',
      {
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        userAgent: req.headers['user-agent'],
        timestamp: new Date().toISOString(),
      },
    );
    return res.status(400).json({
      error: 'Credentials must be sent in request body, not query parameters.',
    });
  }

  try {
    // Initialize default users if needed
    await initializeUsers();

    const { username, password } = req.body;
    const normalizedUsername =
      typeof username === 'string' ? username.trim() : '';
    const normalizedPassword = typeof password === 'string' ? password : '';
    const ip = clientIp(req);

    if (!normalizedUsername || !normalizedPassword) {
      return res
        .status(400)
        .json({ error: 'Username and password are required' });
    }

    const lockoutSeconds = await getLockoutSeconds(normalizedUsername, ip);
    if (lockoutSeconds > 0) {
      return res.status(429).json({
        error: 'Too many failed login attempts. Please try again later.',
        retryAfterSeconds: lockoutSeconds,
      });
    }

    // Verify credentials
    const user = await verifyCredentials(
      normalizedUsername,
      normalizedPassword,
    );

    if (!user) {
      await recordFailedLogin(normalizedUsername, ip);
      // SECURITY: Log failed login attempt with masked username
      console.warn('[AUTH] Failed login attempt', {
        username:
          normalizedUsername.length > 2
            ? normalizedUsername[0] +
              '***' +
              normalizedUsername[normalizedUsername.length - 1]
            : '***',
        ip,
        userAgent: req.headers['user-agent'],
        timestamp: new Date().toISOString(),
      });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    await clearFailedLogins(normalizedUsername, ip);

    // Create session
    await createSession(req, res, user);

    return res.status(200).json({
      success: true,
      user,
    });
  } catch (error) {
    // SECURITY: Log error without exposing sensitive data
    console.error('[AUTH] Login error:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      timestamp: new Date().toISOString(),
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}
