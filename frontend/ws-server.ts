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
import dns from 'node:dns';
import { WebSocketServer, WebSocket } from 'ws';
import Redis, { RedisOptions } from 'ioredis';
import { parse as parseCookie } from 'cookie';
import { primeDns, getCachedIp } from './server/session/dns-cache';

// Prefer IPv4 — Node ≥17 defaults to 'verbatim' which can return AAAA
// records first and stall DNS resolution against Kubernetes CoreDNS.
dns.setDefaultResultOrder('ipv4first');

// ---------- Configuration ----------

const PORT = parseInt(process.env.WS_PORT || '3001', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const HEARTBEAT_INTERVAL = 45_000; // Server sends pong every 45s
const CLIENT_TIMEOUT = 90_000; // Close if no ping received in 90s
const SESSION_EXPIRY = 60 * 60 * 24; // 24 hours (match session.ts)
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const MAX_WS_MESSAGE_BYTES = positiveIntegerFromEnv(
  'WS_MAX_MESSAGE_BYTES',
  64 * 1024,
);
const MAX_JOB_SUBSCRIPTIONS_PER_CONNECTION = positiveIntegerFromEnv(
  'WS_MAX_JOB_SUBSCRIPTIONS_PER_CONNECTION',
  50,
);
const MAX_CHAT_SUBSCRIPTIONS_PER_CONNECTION = positiveIntegerFromEnv(
  'WS_MAX_CHAT_SUBSCRIPTIONS_PER_CONNECTION',
  50,
);
const REDIS_MAX_RETRIES_PER_REQUEST = positiveIntegerFromEnv(
  'REDIS_MAX_RETRIES_PER_REQUEST',
  3,
);
const REDIS_COMMAND_TIMEOUT_MS = positiveIntegerFromEnv(
  'REDIS_COMMAND_TIMEOUT_MS',
  10_000,
);

function resolveRedisUrl(): string {
  try {
    const parsed = new URL(REDIS_URL);
    const cachedIp = getCachedIp(parsed.hostname);
    if (cachedIp && cachedIp !== parsed.hostname) {
      parsed.hostname = cachedIp;
      return parsed.toString();
    }
  } catch {
    // Fall through to raw URL
  }
  return REDIS_URL;
}

try {
  void primeDns(new URL(REDIS_URL).hostname);
} catch {
  // Ignore unparseable URL — connection will fail later with a clearer error.
}

// Collapse repeated transient errors (EAI_AGAIN, ECONNRESET, etc.) into a
// single log line per (label, code) every 30 s so logs are scannable.
type ThrottleState = { count: number; firstSeen: number };
const errorThrottle = new Map<string, ThrottleState>();
const ERROR_LOG_INTERVAL_MS = 30_000;

function logRedisErrorThrottled(label: string, error: unknown): void {
  const code = (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
  const key = `${label}:${code}`;
  const now = Date.now();
  const state = errorThrottle.get(key);
  if (!state) {
    console.error(`[WS] Redis ${label} error (${code}):`, error);
    errorThrottle.set(key, { count: 1, firstSeen: now });
    return;
  }
  if (now - state.firstSeen > ERROR_LOG_INTERVAL_MS) {
    console.error(
      `[WS] Redis ${label} error (${code}) repeated ${state.count}x in last ${Math.round((now - state.firstSeen) / 1000)}s`,
      error,
    );
    errorThrottle.set(key, { count: 1, firstSeen: now });
    return;
  }
  state.count += 1;
}

// ---------- Redis Helpers ----------

const channels = {
  userUpdates: (userId: string) => `user:${userId}:updates`,
};

function sessionKey(parts: string[]): string {
  return parts.filter(Boolean).join(':');
}

// Bound per-command retries and timeouts so Redis outages cannot leave socket
// subscription requests pending indefinitely.
const REDIS_CLIENT_OPTIONS: RedisOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
  enableOfflineQueue: true,
  reconnectOnError: () => true,
  connectTimeout: 10_000,
  commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  retryStrategy: (times) => Math.min(times * 200, 2_000),
  family: 4,
};

function createRedisClient(label: string): Redis {
  const client = new Redis(resolveRedisUrl(), REDIS_CLIENT_OPTIONS);
  client.on('error', (err) => logRedisErrorThrottled(label, err));
  return client;
}

function redisErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isRedisJsonUnavailableForRead(error: unknown): boolean {
  const message = redisErrorMessage(error).toLowerCase();
  return (
    message.includes('unknown command') ||
    message.includes('unknown subcommand') ||
    message.includes('wrongtype') ||
    message.includes('wrong kind of value')
  );
}

function parseRedisJsonResult<T>(raw: string | null): T | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed[0] : parsed) as T;
}

async function getJsonOrPlain<T>(redis: Redis, key: string): Promise<T | null> {
  try {
    return parseRedisJsonResult<T>(await redis.call('JSON.GET', key, '$') as string | null);
  } catch (error) {
    if (!isRedisJsonUnavailableForRead(error)) {
      throw error;
    }
  }

  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch (error) {
    if (isRedisJsonUnavailableForRead(error)) {
      return null;
    }
    throw error;
  }
}

// Shared Redis client for reads
let redisClient: Redis | null = null;
function getRedis(): Redis {
  if (!redisClient) {
    redisClient = createRedisClient('client');
    redisClient.connect().catch((err) => logRedisErrorThrottled('client-connect', err));
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

    return await getJsonOrPlain<SessionData>(redis, key);
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

interface AsyncJobRequestMeta {
  jobId: string;
  userId: string;
}

async function getStreamingStates(userId: string): Promise<Record<string, StreamingState>> {
  const redis = getRedis();
  const pattern = sessionKey(['streaming', 'user', userId, 'conversation', '*']);
  const states: Record<string, StreamingState> = {};

  try {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');

    if (keys.length === 0) return states;

    for (const key of keys) {
      try {
        const state = await getJsonOrPlain<StreamingState>(redis, key);
        if (state?.conversationId) states[state.conversationId] = state;
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

function isSafeChannelId(value: string): boolean {
  return CHANNEL_ID_PATTERN.test(value);
}

function rejectSubscription(conn: ClientConnection, message: string): void {
  sendToConnection(conn, {
    type: 'error',
    message,
  });
}

async function canSubscribeToChat(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const redis = getRedis();
  const userConversationsKey = sessionKey(['user', userId, 'conversations']);
  const streamingKey = sessionKey([
    'streaming',
    'user',
    userId,
    'conversation',
    conversationId,
  ]);

  try {
    if (await redis.sismember(userConversationsKey, conversationId) === 1) {
      return true;
    }
  } catch (error) {
    console.error(`[WS] Error checking conversation ownership for ${conversationId}:`, error);
    return false;
  }

  try {
    const streamingState = await getJsonOrPlain<StreamingState>(redis, streamingKey);
    return Boolean(
      streamingState?.conversationId === conversationId &&
      streamingState.userId === userId,
    );
  } catch (error) {
    console.error(`[WS] Error checking streaming state for ${conversationId}:`, error);
    return false;
  }
}

// ---------- Job Subscription via Redis Pub/Sub ----------

async function subscribeToJob(jobId: string, conn: ClientConnection): Promise<void> {
  if (!isSafeChannelId(jobId)) {
    rejectSubscription(conn, 'Invalid job subscription');
    return;
  }

  if (conn.subscribedJobs.has(jobId)) {
    return;
  }

  if (conn.subscribedJobs.size >= MAX_JOB_SUBSCRIPTIONS_PER_CONNECTION) {
    rejectSubscription(conn, 'Too many job subscriptions');
    return;
  }

  const jobRequest = await getJsonOrPlain<AsyncJobRequestMeta>(
    getRedis(),
    sessionKey(['async-job-request', jobId]),
  ).catch((err) => {
    console.error(`[WS] Error validating job subscription for ${jobId}:`, err);
    return null;
  });

  if (!jobRequest || jobRequest.userId !== conn.userId) {
    console.warn(`[WS] Rejected unauthorized job subscription for ${conn.userId}: ${jobId}`);
    rejectSubscription(conn, 'Unauthorized job subscription');
    return;
  }

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
  if (!isSafeChannelId(conversationId)) {
    rejectSubscription(conn, 'Invalid chat subscription');
    return;
  }

  if (conn.subscribedChats.has(conversationId)) {
    return;
  }

  if (conn.subscribedChats.size >= MAX_CHAT_SUBSCRIPTIONS_PER_CONNECTION) {
    rejectSubscription(conn, 'Too many chat subscriptions');
    return;
  }

  if (!await canSubscribeToChat(userId, conversationId)) {
    console.warn(`[WS] Rejected unauthorized chat subscription for ${userId}: ${conversationId}`);
    rejectSubscription(conn, 'Unauthorized chat subscription');
    return;
  }

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

const wss = new WebSocketServer({ server, maxPayload: MAX_WS_MESSAGE_BYTES });

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
      if (raw.length > MAX_WS_MESSAGE_BYTES) {
        ws.close(1009, 'Message too large');
        return;
      }

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
            if (conn.subscribedJobs.delete(msg.jobId)) {
              unsubscribeFromJob(msg.jobId);
            }
          }
          break;

        case 'subscribe_chat':
          if (msg.conversationId && typeof msg.conversationId === 'string') {
            await subscribeToChat(userId, msg.conversationId, conn);
          }
          break;

        case 'unsubscribe_chat':
          if (msg.conversationId && typeof msg.conversationId === 'string') {
            if (conn.subscribedChats.delete(msg.conversationId)) {
              unsubscribeFromChat(userId, msg.conversationId);
            }
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
