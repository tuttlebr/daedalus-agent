/**
 * WebSocket Sidecar Server
 *
 * Lightweight Node.js process running alongside Next.js that handles all
 * real-time communication over a single WebSocket connection per client.
 * Replaces SSE + polling with unified WebSocket push.
 *
 * Port: 3001 (internal only, proxied via NGINX at /ws)
 */
import { positiveIntegerFromEnv } from './server/config/env';
import { primeDns, getCachedIp } from './server/session/dns-cache';

import { parse as parseCookie } from 'cookie';
import { createServer, IncomingMessage } from 'http';
import Redis, { RedisOptions } from 'ioredis';
import dns from 'node:dns';
import { WebSocketServer, WebSocket } from 'ws';

// Prefer IPv4 — Node ≥17 defaults to 'verbatim' which can return AAAA
// records first and stall DNS resolution against Kubernetes CoreDNS.
dns.setDefaultResultOrder('ipv4first');

// ---------- Configuration ----------

const PORT = parseInt(process.env.WS_PORT || '3001', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const HEARTBEAT_INTERVAL = 45_000; // Server sends pong every 45s
const CLIENT_TIMEOUT = 90_000; // Close if no ping received in 90s
const SESSION_EXPIRY = 60 * 60 * 24; // 24 hours (match session.ts)
// Re-check the session key on a live socket so logout / TTL expiry / sid
// rotation revokes the realtime channel, not just the next HTTP request.
const SESSION_REVALIDATE_INTERVAL =
  positiveIntegerFromEnv('WS_SESSION_REVALIDATE_SECONDS', 60) * 1000;
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

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
      `[WS] Redis ${label} error (${code}) repeated ${
        state.count
      }x in last ${Math.round((now - state.firstSeen) / 1000)}s`,
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
  autoResubscribe: true,
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

interface RedisSubscriberClient {
  connect(): Promise<void>;
  on(
    event: 'message',
    listener: (channel: string, message: string) => void,
  ): unknown;
  quit(): Promise<unknown>;
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
}

type RedisMessageHandler = (message: string) => void;

interface SharedChannelSubscription {
  channel: string;
  handler: RedisMessageHandler;
  refCount: number;
  subscribed: boolean;
}

/**
 * Multiplexes every sidecar Pub/Sub channel over one Redis connection.
 *
 * Refcounts are updated synchronously, while Redis commands are serialized.
 * Reconciliation re-checks the desired state after each awaited command so a
 * retain racing an in-flight unsubscribe (or a release racing subscribe) can
 * never leave the channel in the wrong state.
 */
export class SharedRedisSubscriber {
  private readonly channels = new Map<string, SharedChannelSubscription>();
  private connectPromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private shutdownPromise: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly client: RedisSubscriberClient) {
    client.on('message', (channel, message) => {
      const entry = this.channels.get(channel);
      if (!entry?.subscribed || entry.refCount <= 0) return;

      try {
        entry.handler(message);
      } catch (error) {
        console.error(
          `[WS] Error handling Redis message for ${channel}:`,
          error,
        );
      }
    });
  }

  async retain(channel: string, handler: RedisMessageHandler): Promise<void> {
    if (this.closed) {
      throw new Error('Redis subscriber is shutting down');
    }

    let entry = this.channels.get(channel);
    if (entry) {
      entry.refCount += 1;
    } else {
      entry = {
        channel,
        handler,
        refCount: 1,
        subscribed: false,
      };
      this.channels.set(channel, entry);
    }

    await this.enqueueReconcile(entry);
  }

  async release(channel: string): Promise<void> {
    const entry = this.channels.get(channel);
    if (!entry) return;

    entry.refCount = Math.max(0, entry.refCount - 1);
    await this.enqueueReconcile(entry);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.closed = true;
    for (const entry of this.channels.values()) {
      entry.refCount = 0;
    }

    this.shutdownPromise = this.enqueue(async () => {
      const subscribedChannels = Array.from(this.channels.values())
        .filter((entry) => entry.subscribed)
        .map((entry) => entry.channel);

      if (subscribedChannels.length > 0) {
        await this.client.unsubscribe(...subscribedChannels);
      }
      this.channels.clear();
      await this.client.quit();
    });
    return this.shutdownPromise;
  }

  private ensureConnected(): Promise<void> {
    if (!this.connectPromise) {
      this.connectPromise = this.client.connect().catch((error) => {
        this.connectPromise = null;
        throw error;
      });
    }
    return this.connectPromise;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.operationQueue.then(operation);
    this.operationQueue = pending.catch(() => {});
    return pending;
  }

  private enqueueReconcile(entry: SharedChannelSubscription): Promise<void> {
    return this.enqueue(async () => {
      while (this.channels.get(entry.channel) === entry) {
        const shouldSubscribe = !this.closed && entry.refCount > 0;

        if (shouldSubscribe === entry.subscribed) {
          if (!shouldSubscribe) {
            this.channels.delete(entry.channel);
          }
          return;
        }

        if (shouldSubscribe) {
          await this.ensureConnected();
          await this.client.subscribe(entry.channel);
          entry.subscribed = true;
        } else {
          await this.client.unsubscribe(entry.channel);
          entry.subscribed = false;
        }
      }
    });
  }
}

let sharedRedisSubscriber: SharedRedisSubscriber | null = null;

function getRedisSubscriber(): SharedRedisSubscriber {
  if (!sharedRedisSubscriber) {
    sharedRedisSubscriber = new SharedRedisSubscriber(
      createRedisClient('subscriber'),
    );
  }
  return sharedRedisSubscriber;
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
    return parseRedisJsonResult<T>(
      (await redis.call('JSON.GET', key, '$')) as string | null,
    );
  } catch (error) {
    if (!isRedisJsonUnavailableForRead(error)) {
      throw error;
    }
  }

  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
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
    redisClient
      .connect()
      .catch((err) => logRedisErrorThrottled('client-connect', err));
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

async function validateSession(
  req: IncomingMessage,
): Promise<SessionData | null> {
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

export interface StreamingState {
  conversationId: string;
  sessionId: string;
  startedAt: number;
  userId: string;
}

interface AsyncJobRequestMeta {
  jobId: string;
  userId: string;
}

async function getStreamingStates(
  userId: string,
): Promise<Record<string, StreamingState>> {
  const redis = getRedis();
  const pattern = sessionKey([
    'streaming',
    'user',
    userId,
    'conversation',
    '*',
  ]);
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
  sid: string;
  lastPing: number;
  heartbeatTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  revalidateTimer: NodeJS.Timeout | null;
  subscribedJobs: Set<string>;
  subscribedChats: Set<string>; // conversationIds for token streaming
  releaseChannel: (channel: string) => Promise<void>;
  releaseUserChannel: (() => void) | null;
  initialized: boolean;
  closed: boolean;
}

// userId → Set<ClientConnection>
const connectionsByUser = new Map<string, Set<ClientConnection>>();

function addConnection(conn: ClientConnection): void {
  let userConns = connectionsByUser.get(conn.userId);
  if (!userConns) {
    userConns = new Set();
    connectionsByUser.set(conn.userId, userConns);
  }
  userConns.add(conn);
}

function removeConnection(conn: ClientConnection): void {
  // Idempotent: a socket commonly emits both 'error' and 'close'. Running this
  // twice would double-decrement ref-counted Redis subscribers and tear down
  // channels other live connections (e.g. another browser tab of the same
  // user) still depend on (F-006).
  if (conn.closed) return;
  conn.closed = true;

  const userConns = connectionsByUser.get(conn.userId);
  if (userConns) {
    userConns.delete(conn);
    if (userConns.size === 0) {
      connectionsByUser.delete(conn.userId);
    }
  }

  // Clean up job subscriptions
  for (const jobId of conn.subscribedJobs) {
    void conn
      .releaseChannel(`job:${jobId}:status`)
      .catch((error) => logRedisErrorThrottled('subscriber-release', error));
  }
  conn.subscribedJobs.clear();

  // Clean up chat subscriptions
  for (const convId of conn.subscribedChats) {
    void conn
      .releaseChannel(`user:${conn.userId}:chat:${convId}:tokens`)
      .catch((error) => logRedisErrorThrottled('subscriber-release', error));
  }
  conn.subscribedChats.clear();

  // Release this connection's hold on the user channel (exactly once). The
  // callback is installed immediately before retain starts, so it also rolls
  // back a retain that rejects or races an early socket close.
  const releaseUserChannel = conn.releaseUserChannel;
  conn.releaseUserChannel = null;
  if (releaseUserChannel) {
    try {
      releaseUserChannel();
    } catch (error) {
      logRedisErrorThrottled('subscriber-release', error);
    }
  }

  // Clean up timers
  if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);
  if (conn.timeoutTimer) clearTimeout(conn.timeoutTimer);
  if (conn.revalidateTimer) clearInterval(conn.revalidateTimer);
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
    if ((await redis.sismember(userConversationsKey, conversationId)) === 1) {
      return true;
    }
  } catch (error) {
    console.error(
      `[WS] Error checking conversation ownership for ${conversationId}:`,
      error,
    );
    return false;
  }

  try {
    const streamingState = await getJsonOrPlain<StreamingState>(
      redis,
      streamingKey,
    );
    return Boolean(
      streamingState?.conversationId === conversationId &&
        streamingState.userId === userId,
    );
  } catch (error) {
    console.error(
      `[WS] Error checking streaming state for ${conversationId}:`,
      error,
    );
    return false;
  }
}

// ---------- Job Subscription via Redis Pub/Sub ----------

async function subscribeToJob(
  jobId: string,
  conn: ClientConnection,
  dependencies: ConnectionInitializationDependencies,
): Promise<void> {
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

  const jobRequest = await dependencies.getJobRequest(jobId).catch((err) => {
    console.error(`[WS] Error validating job subscription for ${jobId}:`, err);
    return null;
  });

  if (!jobRequest || jobRequest.userId !== conn.userId) {
    console.warn(
      `[WS] Rejected unauthorized job subscription for ${conn.userId}: ${jobId}`,
    );
    rejectSubscription(conn, 'Unauthorized job subscription');
    return;
  }

  // Validation is asynchronous. Re-check every connection-local invariant
  // before reserving the subscription: a socket may have closed, or a second
  // identical request may have completed validation while this one waited.
  if (conn.closed || conn.subscribedJobs.has(jobId)) return;
  if (conn.subscribedJobs.size >= MAX_JOB_SUBSCRIPTIONS_PER_CONNECTION) {
    rejectSubscription(conn, 'Too many job subscriptions');
    return;
  }

  conn.subscribedJobs.add(jobId);
  const channel = `job:${jobId}:status`;
  try {
    await dependencies.retainChannel(channel, (message) => {
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
  } catch (error) {
    // Roll back this connection's retain unless it was already released by an
    // unsubscribe or disconnect while the Redis command was in flight.
    if (conn.subscribedJobs.delete(jobId)) {
      await dependencies.releaseChannel(channel).catch(() => {});
    }
    throw error;
  }
}

// ---------- Chat Token Subscription via Redis Pub/Sub ----------

async function subscribeToChat(
  userId: string,
  conversationId: string,
  conn: ClientConnection,
  dependencies: ConnectionInitializationDependencies,
): Promise<void> {
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

  if (!(await dependencies.canSubscribeToChat(userId, conversationId))) {
    console.warn(
      `[WS] Rejected unauthorized chat subscription for ${userId}: ${conversationId}`,
    );
    rejectSubscription(conn, 'Unauthorized chat subscription');
    return;
  }

  if (conn.closed || conn.subscribedChats.has(conversationId)) return;
  if (conn.subscribedChats.size >= MAX_CHAT_SUBSCRIPTIONS_PER_CONNECTION) {
    rejectSubscription(conn, 'Too many chat subscriptions');
    return;
  }

  conn.subscribedChats.add(conversationId);

  const channelKey = `user:${userId}:chat:${conversationId}:tokens`;
  try {
    await dependencies.retainChannel(channelKey, (message) => {
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
        console.error(
          `[WS] Error parsing chat token for ${conversationId}:`,
          err,
        );
      }
    });
  } catch (error) {
    if (conn.subscribedChats.delete(conversationId)) {
      await dependencies.releaseChannel(channelKey).catch(() => {});
    }
    throw error;
  }
}

// ---------- User Channel Subscription ----------

async function subscribeToUserChannel(userId: string): Promise<void> {
  const channel = channels.userUpdates(userId);
  await getRedisSubscriber().retain(channel, (message) => {
    try {
      const event = JSON.parse(message);
      // Forward event to all WebSocket connections for this user
      sendToUser(userId, { type: event.type, data: event.data });
    } catch (err) {
      console.error(`[WS] Error parsing user event for ${userId}:`, err);
    }
  });
}

function unsubscribeFromUserChannel(userId: string): void {
  void getRedisSubscriber()
    .release(channels.userUpdates(userId))
    .catch((error) => logRedisErrorThrottled('subscriber-release', error));
}

export interface ConnectionInitializationDependencies {
  subscribeToUserChannel: (userId: string) => Promise<void>;
  unsubscribeFromUserChannel: (userId: string) => void;
  getStreamingStates: (
    userId: string,
  ) => Promise<Record<string, StreamingState>>;
  getJobRequest: (jobId: string) => Promise<AsyncJobRequestMeta | null>;
  canSubscribeToChat: (
    userId: string,
    conversationId: string,
  ) => Promise<boolean>;
  retainChannel: (
    channel: string,
    handler: RedisMessageHandler,
  ) => Promise<void>;
  releaseChannel: (channel: string) => Promise<void>;
}

const defaultConnectionInitializationDependencies: ConnectionInitializationDependencies =
  {
    subscribeToUserChannel,
    unsubscribeFromUserChannel,
    getStreamingStates,
    getJobRequest: (jobId) =>
      getJsonOrPlain<AsyncJobRequestMeta>(
        getRedis(),
        sessionKey(['async-job-request', jobId]),
      ),
    canSubscribeToChat,
    retainChannel: (channel, handler) =>
      getRedisSubscriber().retain(channel, handler),
    releaseChannel: (channel) => getRedisSubscriber().release(channel),
  };

function closeSocketSafely(ws: WebSocket, code: number, reason: string): void {
  if (
    ws.readyState !== WebSocket.CONNECTING &&
    ws.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  try {
    ws.close(code, reason);
  } catch (error) {
    console.error('[WS] Failed to close WebSocket:', error);
  }
}

/**
 * Finish setting up an already-authenticated socket.
 *
 * The event handlers are installed before the first awaited Redis operation.
 * This is exported only to keep the failure/race behavior directly testable.
 */
export async function initializeAuthenticatedConnection(
  ws: WebSocket,
  userId: string,
  sid: string,
  dependencies: ConnectionInitializationDependencies = defaultConnectionInitializationDependencies,
): Promise<void> {
  const conn: ClientConnection = {
    ws,
    userId,
    sid,
    lastPing: Date.now(),
    heartbeatTimer: null,
    timeoutTimer: null,
    revalidateTimer: null,
    subscribedJobs: new Set(),
    subscribedChats: new Set(),
    releaseChannel: dependencies.releaseChannel,
    releaseUserChannel: null,
    initialized: false,
    closed: false,
  };

  const resetTimeout = () => {
    if (conn.timeoutTimer) clearTimeout(conn.timeoutTimer);
    conn.timeoutTimer = setTimeout(() => {
      console.log(`[WS] Client timeout: ${userId}`);
      closeSocketSafely(ws, 4002, 'Ping timeout');
    }, CLIENT_TIMEOUT);
  };

  // Register lifecycle handlers before subscription or state loading. A client
  // is free to disconnect as soon as the HTTP upgrade completes.
  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${userId}`);
    removeConnection(conn);
  });

  ws.on('error', (err) => {
    console.error(`[WS] WebSocket error for ${userId}:`, err);
    removeConnection(conn);
  });

  ws.on('message', async (raw: Buffer) => {
    // Ignore application traffic until the user channel and initial state are
    // ready. This also prevents a pre-initialization message from retaining a
    // job/chat channel after an early disconnect.
    if (!conn.initialized || conn.closed) return;

    try {
      if (raw.length > MAX_WS_MESSAGE_BYTES) {
        closeSocketSafely(ws, 1009, 'Message too large');
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
            await subscribeToJob(msg.jobId, conn, dependencies);
          }
          break;

        case 'unsubscribe_job':
          if (msg.jobId && typeof msg.jobId === 'string') {
            if (conn.subscribedJobs.delete(msg.jobId)) {
              await conn.releaseChannel(`job:${msg.jobId}:status`);
            }
          }
          break;

        case 'subscribe_chat':
          if (msg.conversationId && typeof msg.conversationId === 'string') {
            await subscribeToChat(
              userId,
              msg.conversationId,
              conn,
              dependencies,
            );
          }
          break;

        case 'unsubscribe_chat':
          if (msg.conversationId && typeof msg.conversationId === 'string') {
            if (conn.subscribedChats.delete(msg.conversationId)) {
              await conn.releaseChannel(
                `user:${userId}:chat:${msg.conversationId}:tokens`,
              );
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

  addConnection(conn);

  // Mark the hold before retain starts. removeConnection clears and invokes
  // this callback exactly once, including when retain itself rejects.
  conn.releaseUserChannel = () =>
    dependencies.unsubscribeFromUserChannel(userId);

  try {
    await dependencies.subscribeToUserChannel(userId);
    if (conn.closed || ws.readyState !== WebSocket.OPEN) {
      removeConnection(conn);
      return;
    }

    const streamingStates = await dependencies.getStreamingStates(userId);
    if (conn.closed || ws.readyState !== WebSocket.OPEN) {
      removeConnection(conn);
      return;
    }

    conn.initialized = true;
    sendToConnection(conn, {
      type: 'connected',
      userId,
      streamingStates,
    });
    if (conn.closed || ws.readyState !== WebSocket.OPEN) {
      removeConnection(conn);
      return;
    }

    console.log(
      `[WS] Client connected: ${userId} (${
        connectionsByUser.get(userId)?.size || 0
      } connections)`,
    );

    // Start heartbeat: server sends pong every 45s
    conn.heartbeatTimer = setInterval(() => {
      sendToConnection(conn, { type: 'pong', ts: Date.now() });
    }, HEARTBEAT_INTERVAL);

    // Client timeout: close if no ping received
    resetTimeout();

    // Revoke this socket if its session is deleted (logout), expires, or its
    // sid is rotated (re-login).
    conn.revalidateTimer = setInterval(async () => {
      try {
        const current = await getJsonOrPlain<SessionData>(
          getRedis(),
          sessionKey(['auth-session', sid]),
        );
        if (!current || current.username !== userId) {
          console.log(`[WS] Session ended for ${userId}; closing socket`);
          // 4003 (not 4001) lets a re-login reconnect with the current cookie;
          // a genuine logout/expiry then gets 4001 at the next handshake.
          closeSocketSafely(ws, 4003, 'Session ended');
        }
      } catch (err) {
        // Transient Redis error — don't mass-disconnect on a blip.
        console.error('[WS] Session revalidation error:', err);
      }
    }, SESSION_REVALIDATE_INTERVAL);
  } catch (error) {
    console.error(`[WS] Failed to initialize connection for ${userId}:`, error);
    removeConnection(conn);
    closeSocketSafely(ws, 1011, 'Initialization failed');
  }
}

// ---------- WebSocket Server ----------

const server = createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        connections: Array.from(connectionsByUser.values()).reduce(
          (sum, s) => sum + s.size,
          0,
        ),
        users: connectionsByUser.size,
      }),
    );
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
  const sid = parseCookie(req.headers.cookie || '')['sid'] || '';
  await initializeAuthenticatedConnection(ws, userId, sid);
});

// ---------- Start Server ----------

const shouldStartServer = process.env.NODE_ENV !== 'test';

if (shouldStartServer) {
  server.listen(PORT, () => {
    console.log(`[WS] WebSocket sidecar listening on port ${PORT}`);
  });
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log('[WS] Shutting down...');
  wss.close();
  server.close();

  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }

  await Promise.allSettled([
    sharedRedisSubscriber?.shutdown(),
    redisClient?.quit(),
  ]);
  process.exit(0);
}

if (shouldStartServer) {
  process.once('SIGTERM', () => {
    void shutdown();
  });
}
