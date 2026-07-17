import {
  initializeAuthenticatedConnection,
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

describe('authenticated WebSocket initialization', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
});
