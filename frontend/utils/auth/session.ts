import { NextApiRequest, NextApiResponse } from 'next';

import { isConfiguredUsername } from './config';
import type { User } from './users';

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

// Refresh the current record atomically. Rewriting the earlier jsonGet result
// can recreate a session deleted by logout (or expired) during that await.
// Preserve the existing storage type, including string keys on RedisJSON.
const REFRESH_SESSION_LUA = `
local type_reply = redis.call('TYPE', KEYS[1])
local key_type = type(type_reply) == 'table' and type_reply['ok'] or type_reply
if key_type == 'none' then return nil end
local is_json = string.find(string.lower(key_type), 'rejson', 1, true) ~= nil
local raw
if is_json then
  raw = redis.call('JSON.GET', KEYS[1], '.')
elseif key_type == 'string' then
  raw = redis.call('GET', KEYS[1])
else
  return nil
end
if not raw then return nil end
local session = cjson.decode(raw)
local now = tonumber(ARGV[1])
if now - (tonumber(session['lastActivity']) or 0) > tonumber(ARGV[3]) then
  session['lastActivity'] = now
  raw = cjson.encode(session)
  if is_json then
    redis.call('JSON.SET', KEYS[1], '$', raw)
  else
    redis.call('SET', KEYS[1], raw)
  end
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return raw
`;

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
  if (!isConfiguredUsername(session.username)) {
    // Revoke before the sliding TTL refresh. Persisted account/session records
    // are historical data, not permission to outlive configuration removal.
    await getRedis().del(key);
    clearSessionCookie(req, res);
    return null;
  }

  // Refresh lastActivity + sliding TTL at most once per interval rather than on
  // every request. With a 60s interval and 24h TTL the session still slides for
  // active users, but we avoid a Redis write on every authenticated call.
  const now = Date.now();
  if (now - (session.lastActivity || 0) > ACTIVITY_REFRESH_INTERVAL_MS) {
    const refreshed = await getRedis().eval(
      REFRESH_SESSION_LUA,
      1,
      key,
      now,
      SESSION_EXPIRY,
      ACTIVITY_REFRESH_INTERVAL_MS,
    );
    return typeof refreshed === 'string'
      ? (JSON.parse(refreshed) as SessionData)
      : null;
  }

  return session;
}

// Check if user is authenticated
async function isAuthenticated(
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
