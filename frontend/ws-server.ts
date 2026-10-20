/**
 * WebSocket Sidecar Server
 *
 * Lightweight Node.js process running alongside Next.js that handles all
 * real-time communication over a single WebSocket connection per client.
 * Replaces SSE + polling with unified WebSocket push.
 *
 * Port: 3001 (internal only, proxied via NGINX at /ws)
 */
import { isConfiguredUsername } from './utils/auth/config';

import { isValidConversationId } from './server/chat/conversationId';
import {
  forwardSteeringCommand,
  validateSteeringCommand,
} from './server/chat/steering';
import type { AsyncJobRequest } from './server/chat/types';
import { positiveIntegerFromEnv } from './server/config/env';
import { primeDns } from './server/session/dns-cache';
import {
  channels,
  createRedisErrorThrottle,
  DEFAULT_REDIS_URL,
  JOB_ID_PATTERN,
  parseRedisJsonResult,
  readConversationOwner,
  readJsonFields,
  REDIS_CLIENT_OPTIONS,
  redisErrorMessage,
  resolveRedisUrl,
  sessionKey,
  type StreamingState,
} from './server/session/redisShared';

import { parse as parseCookie } from 'cookie';
import { createServer, IncomingMessage } from 'http';
import Redis from 'ioredis';
import dns from 'node:dns';
import { WebSocketServer, WebSocket } from 'ws';

// Prefer IPv4 — Node ≥17 defaults to 'verbatim' which can return AAAA
// records first and stall DNS resolution against Kubernetes CoreDNS.
dns.setDefaultResultOrder('ipv4first');

// ---------- Configuration ----------

const PORT = parseInt(process.env.WS_PORT || '3001', 10);
const REDIS_URL = process.env.REDIS_URL || DEFAULT_REDIS_URL;
const HEARTBEAT_INTERVAL = 45_000; // Server sends pong every 45s
const CLIENT_TIMEOUT = 90_000; // Close if no ping received in 90s
// Re-check the session key on a live socket so logout / TTL expiry / sid
// rotation revokes the realtime channel, not just the next HTTP request.
const SESSION_REVALIDATE_INTERVAL =
  positiveIntegerFromEnv('WS_SESSION_REVALIDATE_SECONDS', 60) * 1000;

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
const MAX_PENDING_SUBSCRIPTION_CHECKS =
  MAX_JOB_SUBSCRIPTIONS_PER_CONNECTION + MAX_CHAT_SUBSCRIPTIONS_PER_CONNECTION;
// Browsers send their subscriptions as soon as the socket opens, before the
// server has authenticated it and sent `connected`. Hold that bounded backlog
// (every subscription plus a few pings/directions) until initialization ends.
const MAX_PENDING_CLIENT_MESSAGES =
  MAX_JOB_SUBSCRIPTIONS_PER_CONNECTION +
  MAX_CHAT_SUBSCRIPTIONS_PER_CONNECTION +
  16;
const MAX_PENDING_CLIENT_BYTES = 4 * MAX_WS_MESSAGE_BYTES;
try {
  void primeDns(new URL(REDIS_URL).hostname);
} catch {
  // Ignore unparseable URL — connection will fail later with a clearer error.
}

const logRedisErrorThrottled = createRedisErrorThrottle('[WS] ');

// ---------- Redis Helpers ----------

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

function isRedisJsonUnavailableForRead(error: unknown): boolean {
  const message = redisErrorMessage(error).toLowerCase();
  return (
    message.includes('unknown command') ||
    message.includes('unknown subcommand') ||
    message.includes('wrongtype') ||
    message.includes('wrong redis type') ||
    message.includes('wrong kind of value')
  );
}

async function getJsonOrPlain<T>(redis: Redis, key: string): Promise<T | null> {
  try {
    return parseRedisJsonResult(
      (await redis.call('JSON.GET', key, '$')) as string | null,
      '$',
    ) as T | null;
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

// Shared by the initial handshake and periodic revalidation. Account removal
// applies to persisted sessions without rebuilding user/password records here.
export async function readConfiguredSession(
  redis: Redis,
  sessionId: string,
): Promise<SessionData | null> {
  const key = sessionKey(['auth-session', sessionId]);
  const session = await getJsonOrPlain<SessionData>(redis, key);
  if (session && !isConfiguredUsername(session.username)) {
    await redis.del(key);
    return null;
  }
  return session;
}

// ---------- Streaming State ----------

export type { StreamingState };

type AsyncJobRequestMeta = Pick<AsyncJobRequest, 'jobId' | 'userId'> &
  Partial<
    Pick<
      AsyncJobRequest,
      | 'executionMode'
      | 'natBaseUrl'
      | 'natSessionId'
      | 'timezone'
      | 'conversationId'
    >
  >;

// Subscription ownership and steering need only these request fields; the
// record also carries the conversation history.
const JOB_REQUEST_META_FIELDS: Array<keyof AsyncJobRequestMeta> = [
  'jobId',
  'userId',
  'executionMode',
  'natBaseUrl',
  'natSessionId',
  'timezone',
  'conversationId',
];

// Read candidate keys according to their actual type in one round trip.
// Streaming state may be RedisJSON or a plain string (no RedisJSON module).
const READ_STREAMING_STATES_LUA = `
-- READ_STREAMING_STATES
local values = {}
for _, key in ipairs(KEYS) do
  local kind = redis.call('TYPE', key).ok
  local raw = false
  if kind == 'string' then
    raw = redis.call('GET', key)
  elseif string.find(string.lower(kind), 'rejson', 1, true) then
    raw = redis.call('JSON.GET', key, '$')
  end
  table.insert(values, raw)
end
return values
`;
const STREAMING_STATE_READ_BATCH = 500;

/**
 * Streaming state for the user's conversations.
 *
 * The submit route reserves conversation membership before writing streaming
 * state, so candidates come from the user's conversation set. A keyspace-wide
 * SCAN made every (re)connect cost grow with all users' Redis data.
 */
export async function readStreamingStates(
  redis: Redis,
  userId: string,
): Promise<Record<string, StreamingState>> {
  // Redis errors propagate: the client replaces its streaming flags with this
  // snapshot, so an empty result would show running answers as idle.
  // Initialization closes with 1011 instead and the client reconnects.
  const states: Record<string, StreamingState> = {};
  const conversationIds = await redis.smembers(
    sessionKey(['user', userId, 'conversations']),
  );
  for (
    let offset = 0;
    offset < conversationIds.length;
    offset += STREAMING_STATE_READ_BATCH
  ) {
    const keys = conversationIds
      .slice(offset, offset + STREAMING_STATE_READ_BATCH)
      .map((conversationId) =>
        sessionKey([
          'streaming',
          'user',
          userId,
          'conversation',
          conversationId,
        ]),
      );
    const values = (await redis.eval(
      READ_STREAMING_STATES_LUA,
      keys.length,
      ...keys,
    )) as Array<string | null>;
    for (const raw of values) {
      try {
        const state = parseRedisJsonResult(raw, '$') as StreamingState | null;
        if (state?.conversationId) states[state.conversationId] = state;
      } catch {
        // Skip a malformed record; other conversations remain visible.
      }
    }
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
  // Latest subscribe request per channel while ownership validation is in
  // flight. An unsubscribe or newer subscribe replaces it, so validation that
  // finishes late cannot resurrect a subscription the client already dropped.
  pendingSubscriptions: Map<string, object>;
  pendingMessages: PendingClientMessages;
  releaseChannel: (channel: string) => Promise<void>;
  releaseUserChannel: (() => void) | null;
  initialized: boolean;
  closed: boolean;
  steeringInFlight: number;
  subscriptionChecksInFlight: number;
}

interface PendingClientMessages {
  messages: Buffer[];
  bytes: number;
}

function emptyPendingMessages(): PendingClientMessages {
  return { messages: [], bytes: 0 };
}

function queuePendingMessage(
  ws: WebSocket,
  pending: PendingClientMessages,
  raw: Buffer,
): void {
  if (
    pending.messages.length >= MAX_PENDING_CLIENT_MESSAGES ||
    pending.bytes + raw.length > MAX_PENDING_CLIENT_BYTES
  ) {
    pending.messages = [];
    pending.bytes = 0;
    closeSocketSafely(ws, 1008, 'Too many messages before initialization');
    return;
  }
  pending.messages.push(raw);
  pending.bytes += raw.length;
}

function beginSubscription(conn: ClientConnection, channel: string): object {
  const request = {};
  conn.pendingSubscriptions.set(channel, request);
  return request;
}

function finishSubscription(
  conn: ClientConnection,
  channel: string,
  request: object,
): boolean {
  if (conn.pendingSubscriptions.get(channel) !== request) return false;
  conn.pendingSubscriptions.delete(channel);
  return true;
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
  conn.pendingMessages = emptyPendingMessages();
  conn.pendingSubscriptions.clear();

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

function isSafeJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value);
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
  const streamingKey = sessionKey([
    'streaming',
    'user',
    userId,
    'conversation',
    conversationId,
  ]);

  try {
    // Membership and the record's owner binding in one round trip, reading
    // only the record's leading bytes rather than its history.
    const ownership = await readConversationOwner(
      redis,
      userId,
      conversationId,
    );
    if (ownership.member) {
      return !ownership.ownerId || ownership.ownerId === userId;
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
  if (!isSafeJobId(jobId)) {
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

  const channel = `job:${jobId}:status`;
  const request = beginSubscription(conn, channel);
  const jobRequest = await dependencies.getJobRequest(jobId).catch((err) => {
    console.error(`[WS] Error validating job subscription for ${jobId}:`, err);
    return null;
  });
  // A later unsubscribe/subscribe for this channel supersedes this request.
  if (!finishSubscription(conn, channel, request)) return;

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
  // Subscriptions to this job are validated against jobRequest.userId above,
  // so only this user's connections can hold one. Scope the fan-out to them
  // instead of scanning every connection of every user per status message.
  const ownerUserId = conn.userId;
  try {
    await dependencies.retainChannel(channel, (message) => {
      try {
        const status = JSON.parse(message);
        const userConns = connectionsByUser.get(ownerUserId);
        if (userConns) {
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
  // The same rule admits a conversation at chat submission, so every
  // conversation that can run a job can also receive its live events.
  if (!isValidConversationId(conversationId)) {
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

  const channelKey = `user:${userId}:chat:${conversationId}:tokens`;
  const request = beginSubscription(conn, channelKey);
  const allowed = await dependencies
    .canSubscribeToChat(userId, conversationId)
    .catch((err) => {
      console.error(
        `[WS] Error validating chat subscription for ${conversationId}:`,
        err,
      );
      return false;
    });
  // A later unsubscribe/subscribe for this channel supersedes this request.
  if (!finishSubscription(conn, channelKey, request)) return;

  if (!allowed) {
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
  getSession: (sessionId: string) => Promise<SessionData | null>;
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
    getSession: (sessionId) => readConfiguredSession(getRedis(), sessionId),
    subscribeToUserChannel,
    unsubscribeFromUserChannel,
    getStreamingStates: (userId) => readStreamingStates(getRedis(), userId),
    getJobRequest: async (jobId) =>
      (await readJsonFields<AsyncJobRequestMeta>(
        getRedis(),
        sessionKey(['async-job-request', jobId]),
        JOB_REQUEST_META_FIELDS,
      )) as AsyncJobRequestMeta | null,
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
  earlyMessages: Buffer[] = [],
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
    pendingSubscriptions: new Map(),
    pendingMessages: {
      messages: [...earlyMessages],
      bytes: earlyMessages.reduce((total, raw) => total + raw.length, 0),
    },
    releaseChannel: dependencies.releaseChannel,
    releaseUserChannel: null,
    initialized: false,
    closed: false,
    steeringInFlight: 0,
    subscriptionChecksInFlight: 0,
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

  const handleMessage = async (raw: Buffer): Promise<void> => {
    try {
      if (raw.length > MAX_WS_MESSAGE_BYTES) {
        closeSocketSafely(ws, 1009, 'Message too large');
        return;
      }

      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'steer_job': {
          if (conn.steeringInFlight >= 4) {
            sendToConnection(conn, {
              type: 'steering_ack',
              jobId: msg.jobId,
              commandId: msg.commandId,
              accepted: false,
              message: 'Wait for the previous direction to be acknowledged',
            });
            break;
          }
          conn.steeringInFlight += 1;
          try {
            const command = validateSteeringCommand(msg);
            const session = await dependencies.getSession(conn.sid);
            if (!session || session.username !== conn.userId) {
              closeSocketSafely(ws, 4003, 'Session expired');
              return;
            }
            const job = await dependencies.getJobRequest(command.jobId);
            await forwardSteeringCommand(
              conn.userId,
              command,
              job as AsyncJobRequest | null,
            );
            sendToConnection(conn, {
              type: 'steering_ack',
              jobId: command.jobId,
              commandId: command.commandId,
              accepted: true,
            });
          } catch (error) {
            sendToConnection(conn, {
              type: 'steering_ack',
              jobId: msg.jobId,
              commandId: msg.commandId,
              accepted: false,
              message:
                error instanceof Error && error.name !== 'TimeoutError'
                  ? error.message
                  : 'Steering delivery was not confirmed; retry this direction',
            });
          } finally {
            conn.steeringInFlight -= 1;
          }
          break;
        }
        case 'ping':
          conn.lastPing = Date.now();
          resetTimeout();
          sendToConnection(conn, { type: 'pong', ts: Date.now() });
          break;

        case 'subscribe_job':
        case 'subscribe_chat': {
          const isJob = msg.type === 'subscribe_job';
          const id = isJob ? msg.jobId : msg.conversationId;
          if (!id || typeof id !== 'string') break;
          // Completed subscriptions alone do not bound concurrent ownership
          // reads. An unsubscribe invalidates their result but cannot cancel
          // the Redis operation, so keep the slot until that operation settles.
          if (
            conn.subscriptionChecksInFlight >= MAX_PENDING_SUBSCRIPTION_CHECKS
          ) {
            rejectSubscription(conn, 'Too many pending subscription checks');
            break;
          }
          conn.subscriptionChecksInFlight += 1;
          try {
            if (isJob) {
              await subscribeToJob(id, conn, dependencies);
            } else {
              await subscribeToChat(userId, id, conn, dependencies);
            }
          } finally {
            conn.subscriptionChecksInFlight -= 1;
          }
          break;
        }

        case 'unsubscribe_job':
          if (msg.jobId && typeof msg.jobId === 'string') {
            const channel = `job:${msg.jobId}:status`;
            conn.pendingSubscriptions.delete(channel);
            if (conn.subscribedJobs.delete(msg.jobId)) {
              await conn.releaseChannel(channel);
            }
          }
          break;

        case 'unsubscribe_chat':
          if (msg.conversationId && typeof msg.conversationId === 'string') {
            const channel = `user:${userId}:chat:${msg.conversationId}:tokens`;
            conn.pendingSubscriptions.delete(channel);
            if (conn.subscribedChats.delete(msg.conversationId)) {
              await conn.releaseChannel(channel);
            }
          }
          break;

        default:
          break;
      }
    } catch (err) {
      console.error(`[WS] Error processing message from ${userId}:`, err);
    }
  };

  ws.on('message', (raw: Buffer) => {
    if (conn.closed) return;
    // Clients send subscriptions as soon as the socket opens. Hold them until
    // the user channel and initial state are ready, then replay them in order.
    // A disconnect discards the backlog, so it cannot retain a job/chat channel
    // for a closed socket.
    if (!conn.initialized) {
      queuePendingMessage(ws, conn.pendingMessages, raw);
      return;
    }
    void handleMessage(raw);
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

    // Revoke this socket if its account is removed from configuration, its
    // session is deleted (logout), expires, or its sid is rotated (re-login).
    conn.revalidateTimer = setInterval(async () => {
      try {
        const current = await dependencies.getSession(sid);
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

    // Each handler starts synchronously, so subscription requests keep their
    // arrival order exactly as later live messages do.
    const backlog = conn.pendingMessages.messages;
    conn.pendingMessages = emptyPendingMessages();
    for (const raw of backlog) void handleMessage(raw);
  } catch (error) {
    console.error(`[WS] Failed to initialize connection for ${userId}:`, error);
    removeConnection(conn);
    closeSocketSafely(ws, 1011, 'Initialization failed');
  }
}

/**
 * Authenticate an upgraded socket, then initialize it.
 *
 * Listeners are attached before the session lookup awaits Redis. Without an
 * `error` listener, a protocol violation received in that window would be an
 * unhandled EventEmitter error and terminate the sidecar for every user.
 * Messages received while authenticating are kept for initialization.
 */
export async function acceptConnection(
  ws: WebSocket,
  cookieHeader: string | undefined,
  dependencies: ConnectionInitializationDependencies = defaultConnectionInitializationDependencies,
): Promise<void> {
  const earlyMessages = emptyPendingMessages();
  const holdMessage = (raw: Buffer) =>
    queuePendingMessage(ws, earlyMessages, raw);
  const reportError = (error: Error) =>
    console.error('[WS] WebSocket error before authentication:', error);
  ws.on('error', reportError);
  ws.on('message', holdMessage);

  const sid = parseCookie(cookieHeader || '')['sid'] || '';
  let session: SessionData | null = null;
  try {
    session = sid ? await dependencies.getSession(sid) : null;
  } catch (error) {
    ws.off('message', holdMessage);
    console.error('[WS] Session validation error:', error);
    // An unavailable session store is not an authentication result. 1013
    // (try again later) keeps the client's reconnect backoff; 4001 stops it.
    closeSocketSafely(ws, 1013, 'Session check unavailable');
    return;
  }
  ws.off('message', holdMessage);

  if (!session) {
    closeSocketSafely(ws, 4001, 'Unauthorized');
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) return;

  // Same tick: the initializer installs its own lifecycle listeners.
  ws.off('error', reportError);
  await initializeAuthenticatedConnection(
    ws,
    session.username,
    sid,
    dependencies,
    earlyMessages.messages,
  );
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

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  void acceptConnection(ws, req.headers.cookie);
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
