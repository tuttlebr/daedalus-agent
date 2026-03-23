import type { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey, jsonSetWithExpiry, jsonGet } from './redis';
import { getSession } from '@/utils/auth/session';
import { publishSyncEvent } from '@/utils/sync/publish';

export interface DeviceInfo {
  userAgent?: string;
  platform?: string;
  screenWidth?: number;
  screenHeight?: number;
  isMobile?: boolean;
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  deviceInfo: DeviceInfo;
  connectedAt: number;
  lastHeartbeat: number;
}

const SESSION_TTL = 300; // 5 minutes - sessions expire if no heartbeat
const MAX_SESSIONS_PER_USER = 10;

// Register a new session
export async function registerSession(
  userId: string,
  sessionId: string,
  deviceInfo: DeviceInfo
): Promise<void> {
  const redis = getRedis();
  const sessionKey_ = sessionKey(['user', userId, 'session', sessionId]);

  const sessionInfo: SessionInfo = {
    sessionId,
    userId,
    deviceInfo,
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };

  await jsonSetWithExpiry(sessionKey_, sessionInfo, SESSION_TTL);

  // Add to user's session set
  const userSessionsKey = sessionKey(['user', userId, 'sessions']);
  await redis.sadd(userSessionsKey, sessionId);
  await redis.expire(userSessionsKey, SESSION_TTL * 2); // Longer expiry for set

  // Publish session event
  await publishSyncEvent(userId, {
    type: 'session_registered',
    timestamp: Date.now(),
    data: { sessionId, deviceInfo },
  });
}

// Unregister a session
export async function unregisterSession(
  userId: string,
  sessionId: string
): Promise<void> {
  const redis = getRedis();
  const sessionKey_ = sessionKey(['user', userId, 'session', sessionId]);

  await redis.del(sessionKey_);

  // Remove from user's session set
  const userSessionsKey = sessionKey(['user', userId, 'sessions']);
  await redis.srem(userSessionsKey, sessionId);

  // Publish session event
  await publishSyncEvent(userId, {
    type: 'session_unregistered',
    timestamp: Date.now(),
    data: { sessionId },
  });
}

// Update session heartbeat
export async function heartbeatSession(
  userId: string,
  sessionId: string
): Promise<boolean> {
  const redis = getRedis();
  const sessionKey_ = sessionKey(['user', userId, 'session', sessionId]);

  const sessionInfo = await jsonGet(sessionKey_) as SessionInfo | null;
  if (!sessionInfo) {
    return false;
  }

  sessionInfo.lastHeartbeat = Date.now();
  await jsonSetWithExpiry(sessionKey_, sessionInfo, SESSION_TTL);

  return true;
}

// Get all active sessions for a user
export async function getActiveSessions(userId: string): Promise<SessionInfo[]> {
  const redis = getRedis();
  const userSessionsKey = sessionKey(['user', userId, 'sessions']);

  const sessionIds = await redis.smembers(userSessionsKey);
  if (sessionIds.length === 0) {
    return [];
  }

  const sessions: SessionInfo[] = [];
  const now = Date.now();

  for (const sessionId of sessionIds) {
    const sessionKey_ = sessionKey(['user', userId, 'session', sessionId]);
    const sessionInfo = await jsonGet(sessionKey_) as SessionInfo | null;

    if (sessionInfo) {
      // Check if session is still valid (heartbeat within TTL)
      if (now - sessionInfo.lastHeartbeat < SESSION_TTL * 1000) {
        sessions.push(sessionInfo);
      } else {
        // Clean up expired session
        await redis.del(sessionKey_);
        await redis.srem(userSessionsKey, sessionId);
      }
    } else {
      // Clean up orphaned session ID
      await redis.srem(userSessionsKey, sessionId);
    }
  }

  return sessions;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSession(req, res);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const userId = session.username;

  if (req.method === 'POST') {
    // Register new session
    const { sessionId, deviceInfo } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID required' });
    }

    try {
      await registerSession(userId, sessionId, deviceInfo || {});
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error registering session:', error);
      return res.status(500).json({ error: 'Failed to register session' });
    }
  } else if (req.method === 'PUT') {
    // Heartbeat
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID required' });
    }

    try {
      const success = await heartbeatSession(userId, sessionId);
      if (!success) {
        // Session expired, re-register
        const { deviceInfo } = req.body;
        await registerSession(userId, sessionId, deviceInfo || {});
      }
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error updating heartbeat:', error);
      return res.status(500).json({ error: 'Failed to update heartbeat' });
    }
  } else if (req.method === 'DELETE') {
    // Unregister session
    const { sessionId } = req.query;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'Session ID required' });
    }

    try {
      await unregisterSession(userId, sessionId);
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error unregistering session:', error);
      return res.status(500).json({ error: 'Failed to unregister session' });
    }
  } else if (req.method === 'GET') {
    // Get active sessions
    try {
      const sessions = await getActiveSessions(userId);
      return res.status(200).json({ sessions });
    } catch (error) {
      console.error('Error getting sessions:', error);
      return res.status(500).json({ error: 'Failed to get sessions' });
    }
  }

  res.setHeader('Allow', ['POST', 'PUT', 'DELETE', 'GET']);
  return res.status(405).json({ error: 'Method not allowed' });
}
