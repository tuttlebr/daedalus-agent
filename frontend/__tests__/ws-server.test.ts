import {
  acceptConnection,
  initializeAuthenticatedConnection,
  readStreamingStates,
  SharedRedisSubscriber,
  type ConnectionInitializationDependencies,
  type StreamingState,
} from '../ws-server';

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeRedisSubscriber {
  connectCalls = 0;
  quitCalls = 0;
  subscribeCalls: string[][] = [];
  unsubscribeCalls: string[][] = [];
  private messageListener: ((channel: string, message: string) => void) | null =
    null;
  private nextSubscribeGate: Deferred | null = null;
  private nextUnsubscribeGate: Deferred | null = null;

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  on(
    _event: 'message',
    listener: (channel: string, message: string) => void,
  ): void {
    this.messageListener = listener;
  }

  async quit(): Promise<void> {
    this.quitCalls += 1;
  }

  async subscribe(...channels: string[]): Promise<void> {
    this.subscribeCalls.push(channels);
    const gate = this.nextSubscribeGate;
    this.nextSubscribeGate = null;
    await gate?.promise;
  }

  async unsubscribe(...channels: string[]): Promise<void> {
    this.unsubscribeCalls.push(channels);
    const gate = this.nextUnsubscribeGate;
    this.nextUnsubscribeGate = null;
    await gate?.promise;
  }

  deferNextSubscribe(): Deferred {
    this.nextSubscribeGate = deferred();
    return this.nextSubscribeGate;
  }

  deferNextUnsubscribe(): Deferred {
    this.nextUnsubscribeGate = deferred();
    return this.nextUnsubscribeGate;
  }

  emit(channel: string, message: string): void {
    this.messageListener?.(channel, message);
  }
}

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.disconnect(code, reason);
  }

  disconnect(code = 1000, reason = ''): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    this.emit('close', code, Buffer.from(reason));
    this.readyState = WebSocket.CLOSED;
  }
}

interface ValueDeferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function valueDeferred<T>(): ValueDeferred<T> {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function connectionDependencies(
  overrides: Partial<ConnectionInitializationDependencies> = {},
): ConnectionInitializationDependencies {
  return {
    getSession: vi.fn().mockResolvedValue(null),
    subscribeToUserChannel: vi.fn().mockResolvedValue(undefined),
    unsubscribeFromUserChannel: vi.fn(),
    getStreamingStates: vi.fn().mockResolvedValue({}),
    getJobRequest: vi.fn().mockResolvedValue(null),
    canSubscribeToChat: vi.fn().mockResolvedValue(false),
    retainChannel: vi.fn().mockResolvedValue(undefined),
    releaseChannel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('SharedRedisSubscriber', () => {
  it('multiplexes multiple channels over one connection and routes messages', async () => {
    const client = new FakeRedisSubscriber();
    const subscriber = new SharedRedisSubscriber(client);
    const alpha = vi.fn();
    const beta = vi.fn();

    await Promise.all([
      subscriber.retain('channel:alpha', alpha),
      subscriber.retain('channel:beta', beta),
    ]);

    expect(client.connectCalls).toBe(1);
    expect(client.subscribeCalls).toEqual([
      ['channel:alpha'],
      ['channel:beta'],
    ]);

    client.emit('channel:alpha', 'first');
    client.emit('channel:beta', 'second');
    expect(alpha).toHaveBeenCalledWith('first');
    expect(beta).toHaveBeenCalledWith('second');

    await subscriber.release('channel:alpha');
    client.emit('channel:alpha', 'ignored');
    expect(alpha).toHaveBeenCalledTimes(1);
    expect(client.unsubscribeCalls).toContainEqual(['channel:alpha']);

    await subscriber.release('channel:beta');
    await subscriber.shutdown();
  });

  it('keeps one Redis subscription when a refcount release races subscribe', async () => {
    const client = new FakeRedisSubscriber();
    const subscriber = new SharedRedisSubscriber(client);
    const handler = vi.fn();
    const subscribeGate = client.deferNextSubscribe();

    const firstRetain = subscriber.retain('job:123:status', handler);
    const secondRetain = subscriber.retain('job:123:status', handler);

    await vi.waitFor(() => expect(client.subscribeCalls).toHaveLength(1));
    const firstRelease = subscriber.release('job:123:status');
    subscribeGate.resolve();
    await Promise.all([firstRetain, secondRetain, firstRelease]);

    expect(client.subscribeCalls).toEqual([['job:123:status']]);
    expect(client.unsubscribeCalls).toHaveLength(0);

    client.emit('job:123:status', 'ready');
    expect(handler).toHaveBeenCalledWith('ready');

    await subscriber.release('job:123:status');
    expect(client.unsubscribeCalls).toEqual([['job:123:status']]);
    await subscriber.shutdown();
  });

  it('resubscribes when a retain races an in-flight unsubscribe', async () => {
    const client = new FakeRedisSubscriber();
    const subscriber = new SharedRedisSubscriber(client);
    const handler = vi.fn();

    await subscriber.retain('chat:tokens', handler);
    const unsubscribeGate = client.deferNextUnsubscribe();
    const release = subscriber.release('chat:tokens');
    await vi.waitFor(() => expect(client.unsubscribeCalls).toHaveLength(1));

    const reacquire = subscriber.retain('chat:tokens', handler);
    unsubscribeGate.resolve();
    await Promise.all([release, reacquire]);

    expect(client.subscribeCalls).toEqual([['chat:tokens'], ['chat:tokens']]);
    client.emit('chat:tokens', 'token');
    expect(handler).toHaveBeenCalledWith('token');

    await subscriber.release('chat:tokens');
    await subscriber.shutdown();
  });

  it('unsubscribes all channels and quits exactly once on shutdown', async () => {
    const client = new FakeRedisSubscriber();
    const subscriber = new SharedRedisSubscriber(client);

    await subscriber.retain('user:one', vi.fn());
    await subscriber.retain('user:two', vi.fn());

    const firstShutdown = subscriber.shutdown();
    const secondShutdown = subscriber.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    await firstShutdown;

    expect(client.unsubscribeCalls).toContainEqual(['user:one', 'user:two']);
    expect(client.quitCalls).toBe(1);
    await expect(subscriber.retain('late', vi.fn())).rejects.toThrow(
      'Redis subscriber is shutting down',
    );
  });
});

describe('streaming state snapshot', () => {
  it('rejects instead of reporting no active streams when Redis fails', async () => {
    // The client replaces its streaming flags with this snapshot. An empty
    // result after a Redis error would show running answers as idle; a
    // rejection closes initialization with 1011 so the client reconnects.
    const redis = {
      smembers: vi.fn().mockResolvedValue(['conversation-1']),
      eval: vi.fn().mockRejectedValue(new Error('LOADING')),
    };
    await expect(readStreamingStates(redis as any, 'alice')).rejects.toThrow(
      'LOADING',
    );
    redis.smembers.mockRejectedValueOnce(new Error('connection lost'));
    await expect(readStreamingStates(redis as any, 'alice')).rejects.toThrow(
      'connection lost',
    );
  });
});

describe('authenticated WebSocket initialization', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('revalidates steering sessions and forwards only the saved owner job', async () => {
    const socket = new FakeWebSocket();
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetcher);
    const getSession = vi.fn().mockResolvedValue({ username: 'alice' });
    const getJobRequest = vi.fn().mockResolvedValue({
      jobId: 'run-1',
      userId: 'bob',
      executionMode: 'stream',
      natBaseUrl: 'http://backend:8000',
    });
    await initializeAuthenticatedConnection(
      socket as unknown as WebSocket,
      'alice',
      'session-1',
      connectionDependencies({ getSession, getJobRequest }),
    );
    const command = {
      type: 'steer_job',
      jobId: 'run-1',
      commandId: '41d0f5b2-c091-4b90-8a3a-d552fbc5d990',
      instruction: 'Finish with available evidence',
    };
    socket.emit('message', Buffer.from(JSON.stringify(command)));
    await vi.waitFor(() =>
      expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual(
        expect.objectContaining({ type: 'steering_ack', accepted: false }),
      ),
    );
    expect(fetcher).not.toHaveBeenCalled();
    getJobRequest.mockResolvedValue({
      jobId: 'run-1',
      userId: 'alice',
      executionMode: 'stream',
      natBaseUrl: 'http://backend:8000',
    });
    socket.emit('message', Buffer.from(JSON.stringify(command)));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls[0][0]).toBe(
      'http://backend:8000/v1/runs/run-1/control',
    );
    getSession.mockResolvedValue(null);
    socket.emit('message', Buffer.from(JSON.stringify(command)));
    await vi.waitFor(() =>
      expect(socket.closeCalls).toContainEqual({
        code: 4003,
        reason: 'Session expired',
      }),
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('installs lifecycle handlers and releases the user channel when subscribe rejects', async () => {
    const socket = new FakeWebSocket();
    const unsubscribe = vi.fn();
    const getStates = vi.fn().mockResolvedValue({});
    const subscribe = vi.fn(async () => {
      expect(socket.listenerCount('close')).toBe(1);
      expect(socket.listenerCount('error')).toBe(1);
      expect(socket.listenerCount('message')).toBe(1);
      throw new Error('subscribe failed');
    });

    await initializeAuthenticatedConnection(
      socket as unknown as WebSocket,
      'alice',
      'session-1',
      connectionDependencies({
        subscribeToUserChannel: subscribe,
        unsubscribeFromUserChannel: unsubscribe,
        getStreamingStates: getStates,
      }),
    );

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledWith('alice');
    expect(getStates).not.toHaveBeenCalled();
    expect(socket.closeCalls).toEqual([
      { code: 1011, reason: 'Initialization failed' },
    ]);
  });

  it('closes a live socket when periodic configured-session validation revokes it', async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const getSession = vi.fn().mockResolvedValue(null);
    const unsubscribe = vi.fn();
    await initializeAuthenticatedConnection(
      socket as unknown as WebSocket,
      'alice',
      'removed-session',
      connectionDependencies({
        getSession,
        unsubscribeFromUserChannel: unsubscribe,
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getSession).toHaveBeenCalledWith('removed-session');
    expect(socket.closeCalls).toEqual([
      { code: 4003, reason: 'Session ended' },
    ]);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('releases and closes the socket when initial state loading rejects', async () => {
    const socket = new FakeWebSocket();
    const unsubscribe = vi.fn();
    const getStates = vi.fn().mockRejectedValue(new Error('state failed'));

    await initializeAuthenticatedConnection(
      socket as unknown as WebSocket,
      'bob',
      'session-2',
      connectionDependencies({
        unsubscribeFromUserChannel: unsubscribe,
        getStreamingStates: getStates,
      }),
    );

    expect(getStates).toHaveBeenCalledWith('bob');
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(socket.sent).toHaveLength(0);
    expect(socket.closeCalls).toEqual([
      { code: 1011, reason: 'Initialization failed' },
    ]);
  });

  it('releases exactly once when the client disconnects during subscribe', async () => {
    const socket = new FakeWebSocket();
    const unsubscribe = vi.fn();
    const subscription = valueDeferred<void>();
    const subscribe = vi.fn(() => subscription.promise);
    const getStates = vi.fn().mockResolvedValue({});

    const initialization = initializeAuthenticatedConnection(
      socket as unknown as WebSocket,
      'chris',
      'session-3',
      connectionDependencies({
        subscribeToUserChannel: subscribe,
        unsubscribeFromUserChannel: unsubscribe,
        getStreamingStates: getStates,
      }),
    );

    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    socket.disconnect();
    expect(unsubscribe).toHaveBeenCalledOnce();

    subscription.resolve(undefined);
    await initialization;

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(getStates).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(0);
  });

  it('releases exactly once when the client disconnects during state loading', async () => {
    const socket = new FakeWebSocket();
    const unsubscribe = vi.fn();
    const states = valueDeferred<Record<string, StreamingState>>();
    const getStates = vi.fn(() => states.promise);

    const initialization = initializeAuthenticatedConnection(
      socket as unknown as WebSocket,
      'carol',
      'session-4',
      connectionDependencies({
        unsubscribeFromUserChannel: unsubscribe,
        getStreamingStates: getStates,
      }),
    );

    await vi.waitFor(() => expect(getStates).toHaveBeenCalledOnce());
    socket.disconnect();
    expect(unsubscribe).toHaveBeenCalledOnce();

    states.resolve({});
    await initialization;

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(socket.sent).toHaveLength(0);
    expect(socket.closeCalls).toHaveLength(0);
  });

  it('does not retain a job channel when the socket closes during ownership validation', async () => {
    const socket = new FakeWebSocket();
    const validation = valueDeferred<{
      jobId: string;
      userId: string;
    } | null>();
    const getJobRequest = vi.fn(() => validation.promise);
    const retainChannel = vi.fn().mockResolvedValue(undefined);
    const releaseChannel = vi.fn().mockResolvedValue(undefined);

    await initializeAuthenticatedConnection(
      socket as unknown as WebSocket,
      'dana',
      'session-5',
      connectionDependencies({
        getJobRequest,
        retainChannel,
        releaseChannel,
      }),
    );

    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'subscribe_job', jobId: 'job-1' })),
    );
    await vi.waitFor(() => expect(getJobRequest).toHaveBeenCalledOnce());
    socket.disconnect();
    validation.resolve({ jobId: 'job-1', userId: 'dana' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(retainChannel).not.toHaveBeenCalled();
    expect(releaseChannel).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: 'job',
      message: { type: 'subscribe_job', jobId: 'job-foreign' },
      overrides: {
        getJobRequest: vi
          .fn()
          .mockResolvedValue({ jobId: 'job-foreign', userId: 'mallory' }),
      },
      error: 'Unauthorized job subscription',
    },
    {
      kind: 'missing job',
      message: { type: 'subscribe_job', jobId: 'job-missing' },
      overrides: { getJobRequest: vi.fn().mockResolvedValue(null) },
      error: 'Unauthorized job subscription',
    },
    {
      kind: 'chat',
      message: { type: 'subscribe_chat', conversationId: 'chat-foreign' },
      overrides: { canSubscribeToChat: vi.fn().mockResolvedValue(false) },
      error: 'Unauthorized chat subscription',
    },
  ])(
    'rejects a $kind subscription the user does not own',
    async ({ message, overrides, error }) => {
      const socket = new FakeWebSocket();
      const retainChannel = vi.fn().mockResolvedValue(undefined);
      await initializeAuthenticatedConnection(
        socket as unknown as WebSocket,
        'alice',
        'session-owner',
        connectionDependencies({ ...overrides, retainChannel }),
      );

      socket.emit('message', Buffer.from(JSON.stringify(message)));

      await vi.waitFor(() =>
        expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
          type: 'error',
          message: error,
        }),
      );
      expect(retainChannel).not.toHaveBeenCalled();
      socket.disconnect();
    },
  );

  // Chat submission and backend workspace scoping use the same rule, so a
  // conversation that can run a job can also receive its live events.
  it.each([
    ['3f2b8c1e-7a4d-4e6f-9b1a-2c3d4e5f6a7b', true],
    ['imported:conv.1_a', true],
    ['-leading-dash', false],
    ['not/a/scope', false],
    ['a'.repeat(129), false],
  ])(
    'applies the shared conversation ID rule to chat subscription %s',
    async (conversationId, accepted) => {
      const socket = new FakeWebSocket();
      const canSubscribeToChat = vi.fn().mockResolvedValue(true);
      const retainChannel = vi.fn().mockResolvedValue(undefined);
      await initializeAuthenticatedConnection(
        socket as unknown as WebSocket,
        'alice',
        'session-ids',
        connectionDependencies({ canSubscribeToChat, retainChannel }),
      );

      socket.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'subscribe_chat', conversationId })),
      );

      if (accepted) {
        await vi.waitFor(() =>
          expect(retainChannel).toHaveBeenCalledWith(
            `user:alice:chat:${conversationId}:tokens`,
            expect.any(Function),
          ),
        );
      } else {
        await vi.waitFor(() =>
          expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
            type: 'error',
            message: 'Invalid chat subscription',
          }),
        );
        expect(canSubscribeToChat).not.toHaveBeenCalled();
        expect(retainChannel).not.toHaveBeenCalled();
      }
      socket.disconnect();
    },
  );

  it('coalesces duplicate chat subscriptions that validate concurrently', async () => {
    const socket = new FakeWebSocket();
    const validation = valueDeferred<boolean>();
    const canSubscribe = vi.fn(() => validation.promise);
    const retainChannel = vi.fn().mockResolvedValue(undefined);
    const releaseChannel = vi.fn().mockResolvedValue(undefined);

    await initializeAuthenticatedConnection(
      socket as unknown as WebSocket,
      'erin',
      'session-6',
      connectionDependencies({
        canSubscribeToChat: canSubscribe,
        retainChannel,
        releaseChannel,
      }),
    );

    const message = Buffer.from(
      JSON.stringify({ type: 'subscribe_chat', conversationId: 'chat-1' }),
    );
    socket.emit('message', message);
    socket.emit('message', message);
    await vi.waitFor(() => expect(canSubscribe).toHaveBeenCalledTimes(2));

    validation.resolve(true);
    await vi.waitFor(() => expect(retainChannel).toHaveBeenCalledOnce());
    expect(retainChannel).toHaveBeenCalledWith(
      'user:erin:chat:chat-1:tokens',
      expect.any(Function),
    );

    socket.disconnect();
    await vi.waitFor(() => expect(releaseChannel).toHaveBeenCalledOnce());
    expect(releaseChannel).toHaveBeenCalledWith('user:erin:chat:chat-1:tokens');
  });

  it.each(['job', 'chat'])(
    'bounds in-flight %s ownership checks even when requests are unsubscribed',
    async (kind) => {
      const socket = new FakeWebSocket();
      const validation = valueDeferred<any>();
      const check = vi.fn(() => validation.promise);
      await initializeAuthenticatedConnection(
        socket as unknown as WebSocket,
        'bounded',
        'bounded-session',
        connectionDependencies(
          kind === 'job'
            ? { getJobRequest: check }
            : { canSubscribeToChat: check },
        ),
      );
      const send = (type: string, index: number) =>
        socket.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: `${type}_${kind}`,
              [kind === 'job' ? 'jobId' : 'conversationId']: `item-${index}`,
            }),
          ),
        );
      try {
        for (let index = 0; index < 200; index += 1) {
          send('subscribe', index);
          // Dropping the subscription does not cancel the Redis request.
          send('unsubscribe', index);
        }
        expect(check).toHaveBeenCalledTimes(100);
        expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
          type: 'error',
          message: 'Too many pending subscription checks',
        });
        validation.resolve(null);
        await new Promise((resolve) => setTimeout(resolve, 0));
        send('subscribe', 201);
        expect(check).toHaveBeenCalledTimes(101);
      } finally {
        validation.resolve(null);
        socket.disconnect();
      }
    },
  );

  // services/websocket.ts resubscribes in `onopen`, before `connected`.
  it('replays subscriptions sent before initialization completes', async () => {
    const socket = new FakeWebSocket();
    const subscription = valueDeferred<void>();
    const retainChannel = vi.fn().mockResolvedValue(undefined);
    const initialization = initializeAuthenticatedConnection(
      socket as unknown as WebSocket,
      'fay',
      'session-7',
      connectionDependencies({
        subscribeToUserChannel: vi.fn(() => subscription.promise),
        getJobRequest: vi
          .fn()
          .mockResolvedValue({ jobId: 'job-7', userId: 'fay' }),
        canSubscribeToChat: vi.fn().mockResolvedValue(true),
        retainChannel,
      }),
    );

    for (const message of [
      { type: 'subscribe_job', jobId: 'job-7' },
      { type: 'subscribe_chat', conversationId: 'chat-7' },
      { type: 'ping' },
    ]) {
      socket.emit('message', Buffer.from(JSON.stringify(message)));
    }
    subscription.resolve(undefined);
    await initialization;

    await vi.waitFor(() => expect(retainChannel).toHaveBeenCalledTimes(2));
    expect(retainChannel.mock.calls.map(([channel]) => channel)).toEqual([
      'job:job-7:status',
      'user:fay:chat:chat-7:tokens',
    ]);
    expect(socket.sent.map((raw) => JSON.parse(raw).type)).toEqual([
      'connected',
      'pong',
    ]);
    socket.disconnect();
  });

  it('discards held messages when the socket closes before initialization', async () => {
    const socket = new FakeWebSocket();
    const subscription = valueDeferred<void>();
    const getJobRequest = vi.fn();
    const retainChannel = vi.fn();
    const initialization = initializeAuthenticatedConnection(
      socket as unknown as WebSocket,
      'gus',
      'session-8',
      connectionDependencies({
        subscribeToUserChannel: vi.fn(() => subscription.promise),
        getJobRequest,
        retainChannel,
      }),
    );

    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'subscribe_job', jobId: 'job-8' })),
    );
    socket.disconnect();
    subscription.resolve(undefined);
    await initialization;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getJobRequest).not.toHaveBeenCalled();
    expect(retainChannel).not.toHaveBeenCalled();
  });

  it('closes a socket whose pre-initialization backlog exceeds its bound', async () => {
    const socket = new FakeWebSocket();
    const subscription = valueDeferred<void>();
    const initialization = initializeAuthenticatedConnection(
      socket as unknown as WebSocket,
      'hal',
      'session-9',
      connectionDependencies({
        subscribeToUserChannel: vi.fn(() => subscription.promise),
      }),
    );

    const ping = Buffer.from(JSON.stringify({ type: 'ping' }));
    for (let index = 0; index < 200; index += 1) socket.emit('message', ping);
    subscription.resolve(undefined);
    await initialization;

    expect(socket.closeCalls).toEqual([
      { code: 1008, reason: 'Too many messages before initialization' },
    ]);
    expect(socket.sent).toHaveLength(0);
  });

  it.each([
    {
      kind: 'job',
      subscribe: { type: 'subscribe_job', jobId: 'job-9' },
      unsubscribe: { type: 'unsubscribe_job', jobId: 'job-9' },
    },
    {
      kind: 'chat',
      subscribe: { type: 'subscribe_chat', conversationId: 'chat-9' },
      unsubscribe: { type: 'unsubscribe_chat', conversationId: 'chat-9' },
    },
  ])(
    'does not retain a $kind channel unsubscribed during ownership validation',
    async ({ subscribe, unsubscribe }) => {
      const socket = new FakeWebSocket();
      const jobValidation = valueDeferred<{
        jobId: string;
        userId: string;
      } | null>();
      const chatValidation = valueDeferred<boolean>();
      const getJobRequest = vi.fn(() => jobValidation.promise);
      const canSubscribeToChat = vi.fn(() => chatValidation.promise);
      const retainChannel = vi.fn().mockResolvedValue(undefined);
      await initializeAuthenticatedConnection(
        socket as unknown as WebSocket,
        'ivy',
        'session-10',
        connectionDependencies({
          getJobRequest,
          canSubscribeToChat,
          retainChannel,
        }),
      );

      socket.emit('message', Buffer.from(JSON.stringify(subscribe)));
      await vi.waitFor(() =>
        expect(
          getJobRequest.mock.calls.length +
            canSubscribeToChat.mock.calls.length,
        ).toBe(1),
      );
      socket.emit('message', Buffer.from(JSON.stringify(unsubscribe)));
      jobValidation.resolve({ jobId: 'job-9', userId: 'ivy' });
      chatValidation.resolve(true);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(retainChannel).not.toHaveBeenCalled();
      socket.disconnect();
    },
  );
});

describe('WebSocket connection authentication', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('survives a protocol error and keeps messages received while authenticating', async () => {
    const socket = new FakeWebSocket();
    const session = valueDeferred<any>();
    const retainChannel = vi.fn().mockResolvedValue(undefined);
    const accepted = acceptConnection(
      socket as unknown as WebSocket,
      'theme=dark; sid=session-11',
      connectionDependencies({
        getSession: vi.fn(() => session.promise),
        getJobRequest: vi
          .fn()
          .mockResolvedValue({ jobId: 'job-11', userId: 'jo' }),
        retainChannel,
      }),
    );

    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'subscribe_job', jobId: 'job-11' })),
    );
    // EventEmitter throws for an `error` event that has no listener; in the
    // sidecar that is an uncaught exception that exits the process.
    expect(() =>
      socket.emit('error', new RangeError('Invalid WebSocket frame')),
    ).not.toThrow();
    session.resolve({ username: 'jo' });
    await accepted;

    await vi.waitFor(() =>
      expect(retainChannel).toHaveBeenCalledWith(
        'job:job-11:status',
        expect.any(Function),
      ),
    );
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      type: 'connected',
      userId: 'jo',
    });
    socket.disconnect();
  });

  it('rejects missing sessions as unauthorized without authenticating unknown cookies', async () => {
    const getSession = vi.fn().mockResolvedValue(null);
    const noCookie = new FakeWebSocket();
    await acceptConnection(
      noCookie as unknown as WebSocket,
      undefined,
      connectionDependencies({ getSession }),
    );
    expect(getSession).not.toHaveBeenCalled();
    expect(noCookie.closeCalls).toEqual([
      { code: 4001, reason: 'Unauthorized' },
    ]);

    const expired = new FakeWebSocket();
    await acceptConnection(
      expired as unknown as WebSocket,
      'sid=expired',
      connectionDependencies({ getSession }),
    );
    expect(getSession).toHaveBeenCalledWith('expired');
    expect(expired.closeCalls).toEqual([
      { code: 4001, reason: 'Unauthorized' },
    ]);
  });

  it('keeps reconnecting possible when the session store is unavailable', async () => {
    // The browser stops reconnecting after 4001; a Redis outage is retryable.
    const socket = new FakeWebSocket();
    const subscribeToUserChannel = vi.fn();
    await acceptConnection(
      socket as unknown as WebSocket,
      'sid=session-12',
      connectionDependencies({
        getSession: vi.fn().mockRejectedValue(new Error('READONLY')),
        subscribeToUserChannel,
      }),
    );

    expect(socket.closeCalls).toEqual([
      { code: 1013, reason: 'Session check unavailable' },
    ]);
    expect(subscribeToUserChannel).not.toHaveBeenCalled();
  });
});
