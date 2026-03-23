/**
 * WebSocket Sidecar Server
 *
 * Lightweight Node.js process running alongside Next.js that handles all
 * real-time communication over a single WebSocket connection per client.
 * Replaces SSE + polling with unified WebSocket push.
 *
 * Port: 3001 (internal only, proxied via NGINX at /ws)
 */

import { createServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import { parse as parseCookie } from 'cookie';

// ---------- Configuration ----------

const PORT = parseInt(process.env.WS_PORT || '3001', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const HEARTBEAT_INTERVAL = 45_000; // Server sends pong every 45s
const CLIENT_TIMEOUT = 90_000; // Close if no ping received in 90s
const SESSION_EXPIRY = 60 * 60 * 24; // 24 hours (match session.ts)

// ---------- Redis Helpers ----------

const channels = {
  userUpdates: (userId: string) => `user:${userId}:updates`,
};

function sessionKey(parts: string[]): string {
  return `daedalus:${parts.join(':')}`;
}

function createRedisClient(label: string): Redis {
  const client = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    reconnectOnError: () => true,
  });
  client.on('error', (err) => console.error(`[WS] Redis ${label} error:`, err));
  return client;
}

// Shared Redis client for reads
let redisClient: Redis | null = null;
function getRedis(): Redis {
  if (!redisClient) {
    redisClient = createRedisClient('client');
    redisClient.connect().catch((err) => console.error('[WS] Redis client connect error:', err));
  }
  return redisClient;
}

// ---------- Session Validation ----------

interface SessionData {
  userId: string;
  username: string;
  name: string;
  loginTime: number;
  lastActivity: number;
}

async function validateSession(req: IncomingMessage): Promise<SessionData | null> {
  try {
    const cookieHeader = req.headers.cookie || '';
    const cookies = parseCookie(cookieHeader);
    const sessionId = cookies['sid'];

    if (!sessionId) return null;

    const redis = getRedis();
    const key = sessionKey(['auth-session', sessionId]);

    // Try RedisJSON first, fall back to plain GET
    try {
      const raw = await redis.call('JSON.GET', key, '$') as string | null;
      if (raw) {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed[0] : parsed;
      }
    } catch {
      // RedisJSON not available, try plain GET
      const raw = await redis.get(key);
      if (raw) return JSON.parse(raw);
    }

    return null;
  } catch (err) {
    console.error('[WS] Session validation error:', err);
    return null;
  }
}

// ---------- Streaming State ----------

interface StreamingState {
  conversationId: string;
  sessionId: string;
  startedAt: number;
  userId: string;
}

async function getStreamingStates(userId: string): Promise<Record<string, StreamingState>> {
  const redis = getRedis();
  const pattern = sessionKey(['streaming', 'user', userId, 'conversation', '*']);
  const states: Record<string, StreamingState> = {};

  try {
    const keys = await redis.keys(pattern);
    if (keys.length === 0) return states;

    for (const key of keys) {
      try {
        let raw: string | null = null;
        try {
          const jsonRaw = await redis.call('JSON.GET', key, '$') as string | null;
          if (jsonRaw) {
            const parsed = JSON.parse(jsonRaw);
            const state = Array.isArray(parsed) ? parsed[0] : parsed;
            if (state?.conversationId) states[state.conversationId] = state;
            continue;
          }
        } catch {
          // RedisJSON not available
        }
        raw = await redis.get(key);
        if (raw) {
          const state = JSON.parse(raw);
          if (state?.conversationId) states[state.conversationId] = state;
        }
      } catch {
        // Skip individual key errors
      }
    }
  } catch (err) {
    console.error('[WS] Error getting streaming states:', err);
  }

  return states;
}

// ---------- Connection Manager ----------

interface ClientConnection {
  ws: WebSocket;
  userId: string;
  lastPing: number;
  heartbeatTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  subscribedJobs: Set<string>;
  subscribedChats: Set<string>; // conversationIds for token streaming
}

// userId → Set<ClientConnection>
const connectionsByUser = new Map<string, Set<ClientConnection>>();

// jobId → Redis subscriber
const jobSubscribers = new Map<string, { subscriber: Redis; refCount: number }>();

function addConnection(conn: ClientConnection): void {
  let userConns = connectionsByUser.get(conn.userId);
  if (!userConns) {
    userConns = new Set();
    connectionsByUser.set(conn.userId, userConns);
  }
  userConns.add(conn);
}

function removeConnection(conn: ClientConnection): void {
  const userConns = connectionsByUser.get(conn.userId);
  if (userConns) {
    userConns.delete(conn);
    if (userConns.size === 0) {
      connectionsByUser.delete(conn.userId);
    }
  }

  // Clean up job subscriptions
  for (const jobId of conn.subscribedJobs) {
    unsubscribeFromJob(jobId);
  }

  // Clean up chat subscriptions
  for (const convId of conn.subscribedChats) {
    unsubscribeFromChat(conn.userId, convId);
  }

  // Clean up timers
  if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);
  if (conn.timeoutTimer) clearTimeout(conn.timeoutTimer);
}

function sendToUser(userId: string, message: object): void {
  const userConns = connectionsByUser.get(userId);
  if (!userConns) return;

  const data = JSON.stringify(message);
  for (const conn of userConns) {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(data);
    }
  }
}

function sendToConnection(conn: ClientConnection, message: object): void {
  if (conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(message));
  }
}

// ---------- Job Subscription via Redis Pub/Sub ----------

async function subscribeToJob(jobId: string, conn: ClientConnection): Promise<void> {
  conn.subscribedJobs.add(jobId);

  const existing = jobSubscribers.get(jobId);
  if (existing) {
    existing.refCount++;
    return;
  }

  const sub = createRedisClient(`job-sub-${jobId}`);
  await sub.connect();

  const channel = `job:${jobId}:status`;
  sub.on('message', (receivedChannel: string, message: string) => {
    if (receivedChannel !== channel) return;
    try {
      const status = JSON.parse(message);
      // Fan out to all connections subscribed to this job
      for (const [, userConns] of connectionsByUser) {
        for (const c of userConns) {
          if (c.subscribedJobs.has(jobId)) {
            sendToConnection(c, { type: 'job_status', data: status });
          }
        }
      }
    } catch (err) {
      console.error(`[WS] Error parsing job status for ${jobId}:`, err);
    }
  });

  await sub.subscribe(channel);
  jobSubscribers.set(jobId, { subscriber: sub, refCount: 1 });
}

function unsubscribeFromJob(jobId: string): void {
  const entry = jobSubscribers.get(jobId);
  if (!entry) return;

  entry.refCount--;
  if (entry.refCount <= 0) {
    const channel = `job:${jobId}:status`;
    entry.subscriber.unsubscribe(channel).catch(() => {});
    entry.subscriber.quit().catch(() => {});
    jobSubscribers.delete(jobId);
  }
}

// ---------- Chat Token Subscription via Redis Pub/Sub ----------

// channelKey → Redis subscriber (ref-counted)
const chatSubscribers = new Map<string, { subscriber: Redis; refCount: number }>();

async function subscribeToChat(userId: string, conversationId: string, conn: ClientConnection): Promise<void> {
  conn.subscribedChats.add(conversationId);

  const channelKey = `user:${userId}:chat:${conversationId}:tokens`;
  const existing = chatSubscribers.get(channelKey);
  if (existing) {
    existing.refCount++;
    return;
  }

  const sub = createRedisClient(`chat-sub-${conversationId.slice(0, 8)}`);
  await sub.connect();

  sub.on('message', (receivedChannel: string, message: string) => {
    if (receivedChannel !== channelKey) return;
    try {
      const event = JSON.parse(message);
      // Forward to all connections for this user subscribed to this conversation
      const userConns = connectionsByUser.get(userId);
      if (userConns) {
        for (const c of userConns) {
          if (c.subscribedChats.has(conversationId)) {
            sendToConnection(c, event);
          }
        }
      }
    } catch (err) {
      console.error(`[WS] Error parsing chat token for ${conversationId}:`, err);
    }
  });

  await sub.subscribe(channelKey);
  chatSubscribers.set(channelKey, { subscriber: sub, refCount: 1 });
}

function unsubscribeFromChat(userId: string, conversationId: string): void {
  const channelKey = `user:${userId}:chat:${conversationId}:tokens`;
  const entry = chatSubscribers.get(channelKey);
  if (!entry) return;

  entry.refCount--;
  if (entry.refCount <= 0) {
    entry.subscriber.unsubscribe(channelKey).catch(() => {});
    entry.subscriber.quit().catch(() => {});
    chatSubscribers.delete(channelKey);
  }
}

// ---------- User Channel Subscription ----------

// userId → dedicated Redis subscriber
const userSubscribers = new Map<string, { subscriber: Redis; refCount: number }>();

async function subscribeToUserChannel(userId: string): Promise<void> {
  const existing = userSubscribers.get(userId);
  if (existing) {
    existing.refCount++;
    return;
  }

  const sub = createRedisClient(`user-sub-${userId}`);
  await sub.connect();

  const channel = channels.userUpdates(userId);
  sub.on('message', (receivedChannel: string, message: string) => {
    if (receivedChannel !== channel) return;
    try {
      const event = JSON.parse(message);
      // Forward event to all WebSocket connections for this user
      sendToUser(userId, { type: event.type, data: event.data });
    } catch (err) {
      console.error(`[WS] Error parsing user event for ${userId}:`, err);
    }
  });

  await sub.subscribe(channel);
  userSubscribers.set(userId, { subscriber: sub, refCount: 1 });
}

function unsubscribeFromUserChannel(userId: string): void {
  const entry = userSubscribers.get(userId);
  if (!entry) return;

  entry.refCount--;
  if (entry.refCount <= 0) {
    const channel = channels.userUpdates(userId);
    entry.subscriber.unsubscribe(channel).catch(() => {});
    entry.subscriber.quit().catch(() => {});
    userSubscribers.delete(userId);
  }
}

// ---------- WebSocket Server ----------

const server = createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      connections: Array.from(connectionsByUser.values()).reduce((sum, s) => sum + s.size, 0),
      users: connectionsByUser.size,
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
  // Authenticate
  const session = await validateSession(req);
  if (!session) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  const userId = session.username;
  const conn: ClientConnection = {
    ws,
    userId,
    lastPing: Date.now(),
    heartbeatTimer: null,
    timeoutTimer: null,
    subscribedJobs: new Set(),
    subscribedChats: new Set(),
  };

  addConnection(conn);

  // Subscribe to user's Redis channel
  await subscribeToUserChannel(userId);

  // Send connected event with current streaming states
  const streamingStates = await getStreamingStates(userId);
  sendToConnection(conn, {
    type: 'connected',
    userId,
    streamingStates,
  });

  console.log(`[WS] Client connected: ${userId} (${connectionsByUser.get(userId)?.size || 0} connections)`);

  // Start heartbeat: server sends pong every 45s
  conn.heartbeatTimer = setInterval(() => {
    sendToConnection(conn, { type: 'pong', ts: Date.now() });
  }, HEARTBEAT_INTERVAL);

  // Client timeout: close if no ping received
  const resetTimeout = () => {
    if (conn.timeoutTimer) clearTimeout(conn.timeoutTimer);
    conn.timeoutTimer = setTimeout(() => {
      console.log(`[WS] Client timeout: ${userId}`);
      ws.close(4002, 'Ping timeout');
    }, CLIENT_TIMEOUT);
  };
  resetTimeout();

  // Handle messages from client
  ws.on('message', async (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'ping':
          conn.lastPing = Date.now();
          resetTimeout();
          sendToConnection(conn, { type: 'pong', ts: Date.now() });
          break;

        case 'subscribe_job':
          if (msg.jobId && typeof msg.jobId === 'string') {
            await subscribeToJob(msg.jobId, conn);
          }
          break;

        case 'unsubscribe_job':
          if (msg.jobId && typeof msg.jobId === 'string') {
            conn.subscribedJobs.delete(msg.jobId);
            unsubscribeFromJob(msg.jobId);
          }
          break;

        case 'subscribe_chat':
          if (msg.conversationId && typeof msg.conversationId === 'string') {
            await subscribeToChat(userId, msg.conversationId, conn);
          }
          break;

        case 'unsubscribe_chat':
          if (msg.conversationId && typeof msg.conversationId === 'string') {
            conn.subscribedChats.delete(msg.conversationId);
            unsubscribeFromChat(userId, msg.conversationId);
          }
          break;

        default:
          break;
      }
    } catch (err) {
      console.error(`[WS] Error processing message from ${userId}:`, err);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${userId}`);
    removeConnection(conn);
    unsubscribeFromUserChannel(userId);
  });

  ws.on('error', (err) => {
    console.error(`[WS] WebSocket error for ${userId}:`, err);
    removeConnection(conn);
    unsubscribeFromUserChannel(userId);
  });
});

// ---------- Start Server ----------

server.listen(PORT, () => {
  console.log(`[WS] WebSocket sidecar listening on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[WS] Shutting down...');
  wss.close();
  server.close();

  // Close all Redis connections
  for (const [, entry] of userSubscribers) {
    entry.subscriber.quit().catch(() => {});
  }
  for (const [, entry] of jobSubscribers) {
    entry.subscriber.quit().catch(() => {});
  }
  for (const [, entry] of chatSubscribers) {
    entry.subscriber.quit().catch(() => {});
  }
  if (redisClient) redisClient.quit().catch(() => {});

  process.exit(0);
});
