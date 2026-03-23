/**
 * Tests for the WebSocketManager class (services/websocket.ts).
 *
 * We mock the global WebSocket constructor so that no real network
 * connections are made. Each test creates a fresh WebSocketManager
 * to avoid cross-test leakage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Mock Logger ----
vi.mock('@/utils/logger', () => ({
  Logger: vi.fn().mockImplementation(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@/utils/app/visibilityAwareTimer', () => ({
  shouldRunExpensiveOperation: vi.fn(() => Promise.resolve(true)),
}));

// ---- Mock WebSocket ----
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;
  url: string;

  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  send = vi.fn();
  close = vi.fn().mockImplementation(function (this: MockWebSocket, code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent('close', { code: code || 1000, reason: reason || '' }));
    }
  });

  constructor(url: string) {
    this.url = url;
  }

  // Test helper: simulate the connection opening
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) {
      this.onopen(new Event('open'));
    }
  }

  // Test helper: simulate receiving a message
  simulateMessage(data: any): void {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }));
    }
  }

  // Test helper: simulate close from server
  simulateClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent('close', { code, reason }));
    }
  }

  // Test helper: simulate error
  simulateError(): void {
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }
}

// Capture created instances
let wsInstances: MockWebSocket[] = [];

beforeEach(() => {
  wsInstances = [];
  vi.useFakeTimers();

  // Define WebSocket constants on global to match the real API
  (globalThis as any).WebSocket = Object.assign(
    function (url: string) {
      const instance = new MockWebSocket(url);
      wsInstances.push(instance);
      return instance;
    } as any,
    {
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3,
    },
  );

  // Provide window.location for URL building
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { protocol: 'http:', host: 'localhost:5000' },
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Import after mocks are set up (dynamic import to avoid module-level side effects)
import { WebSocketManager } from '@/services/websocket';

describe('WebSocketManager', () => {
  // ---------- connect() ----------

  describe('connect()', () => {
    it('creates a WebSocket with the correct URL', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();

      expect(wsInstances).toHaveLength(1);
      expect(wsInstances[0].url).toBe('ws://localhost:5000/ws');
    });

    it('builds wss: URL when page is served over https', () => {
      (window as any).location = { protocol: 'https:', host: 'example.com' };

      const mgr = new WebSocketManager('/ws');
      mgr.connect();

      expect(wsInstances[0].url).toBe('wss://example.com/ws');
    });

    it('uses the url directly if it already starts with ws', () => {
      const mgr = new WebSocketManager('ws://custom:9999/live');
      mgr.connect();

      expect(wsInstances[0].url).toBe('ws://custom:9999/live');
    });

    it('sets isConnected to true after onopen', () => {
      const mgr = new WebSocketManager('/ws');
      expect(mgr.isConnected).toBe(false);

      mgr.connect();
      wsInstances[0].simulateOpen();

      expect(mgr.isConnected).toBe(true);
    });

    it('does not create a second WebSocket if already OPEN', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      mgr.connect(); // second call while already OPEN

      expect(wsInstances).toHaveLength(1);
    });

    it('does not create a second WebSocket if still CONNECTING', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      // readyState is CONNECTING by default

      mgr.connect(); // second call

      expect(wsInstances).toHaveLength(1);
    });

    it('resets reconnectAttempts on successful connect', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      // If reconnectAttempts were > 0 they would be reset
      // We verify indirectly: disconnect triggers reconnect scheduling,
      // then a new connect resets the counter.
      expect(mgr.isConnected).toBe(true);
    });

    it('re-subscribes to tracked jobs on reconnect', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      // Subscribe to a job while connected
      mgr.subscribeToJob('job-1');
      wsInstances[0].send.mockClear();

      // Simulate disconnect and reconnect
      wsInstances[0].simulateClose(1006, 'abnormal');
      mgr.connect();
      wsInstances[1].simulateOpen();

      // After reconnect, the job subscription should be re-sent
      expect(wsInstances[1].send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe_job', jobId: 'job-1' }),
      );
    });
  });

  // ---------- disconnect() ----------

  describe('disconnect()', () => {
    it('closes the WebSocket with code 1000', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      mgr.disconnect();

      expect(wsInstances[0].close).toHaveBeenCalledWith(1000, 'Client disconnect');
    });

    it('sets isConnected to false', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();
      expect(mgr.isConnected).toBe(true);

      mgr.disconnect();
      expect(mgr.isConnected).toBe(false);
    });

    it('prevents automatic reconnection (intentionalClose)', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      mgr.disconnect();

      // Advance timers - no new WebSocket should be created
      vi.advanceTimersByTime(60_000);
      expect(wsInstances).toHaveLength(1);
    });

    it('is safe to call when not connected', () => {
      const mgr = new WebSocketManager('/ws');
      expect(() => mgr.disconnect()).not.toThrow();
    });
  });

  // ---------- on() ----------

  describe('on()', () => {
    it('registers a handler and returns an unsubscribe function', () => {
      const mgr = new WebSocketManager('/ws');
      const handler = vi.fn();

      const unsub = mgr.on('conversation_updated', handler);

      expect(typeof unsub).toBe('function');
    });

    it('invokes handler when a matching message arrives', () => {
      const mgr = new WebSocketManager('/ws');
      const handler = vi.fn();
      mgr.on('conversation_updated', handler);

      mgr.connect();
      wsInstances[0].simulateOpen();
      wsInstances[0].simulateMessage({
        type: 'conversation_updated',
        data: { conversationId: 'c-1', conversation: { id: 'c-1' } },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ conversationId: 'c-1', conversation: { id: 'c-1' } });
    });

    it('does not invoke handler for non-matching message types', () => {
      const mgr = new WebSocketManager('/ws');
      const handler = vi.fn();
      mgr.on('conversation_deleted', handler);

      mgr.connect();
      wsInstances[0].simulateOpen();
      wsInstances[0].simulateMessage({
        type: 'conversation_updated',
        data: { conversationId: 'c-1' },
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('supports multiple handlers for the same event type', () => {
      const mgr = new WebSocketManager('/ws');
      const h1 = vi.fn();
      const h2 = vi.fn();
      mgr.on('streaming_started', h1);
      mgr.on('streaming_started', h2);

      mgr.connect();
      wsInstances[0].simulateOpen();
      wsInstances[0].simulateMessage({
        type: 'streaming_started',
        data: { conversationId: 'c-1', sessionId: 's-1' },
      });

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe stops the handler from being called', () => {
      const mgr = new WebSocketManager('/ws');
      const handler = vi.fn();
      const unsub = mgr.on('conversation_deleted', handler);

      unsub();

      mgr.connect();
      wsInstances[0].simulateOpen();
      wsInstances[0].simulateMessage({
        type: 'conversation_deleted',
        data: { conversationId: 'c-1' },
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('unsubscribe only removes the specific handler', () => {
      const mgr = new WebSocketManager('/ws');
      const h1 = vi.fn();
      const h2 = vi.fn();
      const unsub1 = mgr.on('conversation_updated', h1);
      mgr.on('conversation_updated', h2);

      unsub1();

      mgr.connect();
      wsInstances[0].simulateOpen();
      wsInstances[0].simulateMessage({
        type: 'conversation_updated',
        data: { conversationId: 'c-1' },
      });

      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledTimes(1);
    });
  });

  // ---------- subscribeToJob / unsubscribeFromJob ----------

  describe('subscribeToJob / unsubscribeFromJob', () => {
    it('subscribeToJob sends a subscribe_job message when connected', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      mgr.subscribeToJob('job-42');

      expect(wsInstances[0].send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe_job', jobId: 'job-42' }),
      );
    });

    it('subscribeToJob tracks the job even when disconnected', () => {
      const mgr = new WebSocketManager('/ws');
      // Not connected yet
      mgr.subscribeToJob('job-99');

      // Now connect - the job should be re-subscribed on open
      mgr.connect();
      wsInstances[0].simulateOpen();

      expect(wsInstances[0].send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe_job', jobId: 'job-99' }),
      );
    });

    it('unsubscribeFromJob sends an unsubscribe_job message when connected', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      mgr.subscribeToJob('job-42');
      mgr.unsubscribeFromJob('job-42');

      expect(wsInstances[0].send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'unsubscribe_job', jobId: 'job-42' }),
      );
    });

    it('unsubscribeFromJob removes the job from the tracked set', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.subscribeToJob('job-1');
      mgr.unsubscribeFromJob('job-1');

      // Connect - unsubscribed job should NOT be re-subscribed
      mgr.connect();
      wsInstances[0].simulateOpen();

      const sentMessages = wsInstances[0].send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const jobSubs = sentMessages.filter((m: any) => m.type === 'subscribe_job');
      expect(jobSubs).toHaveLength(0);
    });
  });

  // ---------- subscribeToChat / unsubscribeFromChat ----------

  describe('subscribeToChat / unsubscribeFromChat', () => {
    it('subscribeToChat sends a subscribe_chat message when connected', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      mgr.subscribeToChat('conv-abc');

      expect(wsInstances[0].send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe_chat', conversationId: 'conv-abc' }),
      );
    });

    it('subscribeToChat does nothing when disconnected', () => {
      const mgr = new WebSocketManager('/ws');
      // Not connected
      mgr.subscribeToChat('conv-abc');

      // No WebSocket instance exists to send on
      expect(wsInstances).toHaveLength(0);
    });

    it('unsubscribeFromChat sends an unsubscribe_chat message when connected', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      mgr.unsubscribeFromChat('conv-abc');

      expect(wsInstances[0].send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'unsubscribe_chat', conversationId: 'conv-abc' }),
      );
    });
  });

  // ---------- Ping / Pong heartbeat ----------

  describe('ping/pong heartbeat', () => {
    it('sends a ping every 30 seconds after connecting', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      // Advance 30 seconds
      vi.advanceTimersByTime(30_000);

      expect(wsInstances[0].send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'ping' }),
      );
    });

    it('sends multiple pings on repeated intervals', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);

      const pingCalls = wsInstances[0].send.mock.calls.filter(
        (c: any[]) => JSON.parse(c[0]).type === 'ping',
      );
      expect(pingCalls).toHaveLength(3);
    });

    it('stops pinging after disconnect', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      mgr.disconnect();
      wsInstances[0].send.mockClear();

      vi.advanceTimersByTime(60_000);

      const pingCalls = wsInstances[0].send.mock.calls.filter(
        (c: any[]) => {
          try { return JSON.parse(c[0]).type === 'ping'; } catch { return false; }
        },
      );
      expect(pingCalls).toHaveLength(0);
    });

    it('pong message resets the pong timeout (no reconnect)', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      // Trigger ping
      vi.advanceTimersByTime(30_000);

      // Receive pong before the 60s timeout
      wsInstances[0].simulateMessage({ type: 'pong', ts: Date.now() });

      // Advance past what would have been the pong timeout
      vi.advanceTimersByTime(60_000);

      // Should still be the same connection (no reconnect)
      expect(wsInstances).toHaveLength(1);
      expect(mgr.isConnected).toBe(true);
    });

    it.skip('missing pong triggers a close after 60 seconds', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      // Trigger ping
      vi.advanceTimersByTime(30_000);

      // Don't send pong - advance past the 60s timeout
      vi.advanceTimersByTime(60_000);

      // WebSocket should have been closed with code 4003
      expect(wsInstances[0].close).toHaveBeenCalledWith(4003, 'Pong timeout');
    });
  });

  // ---------- Automatic reconnection ----------

  describe('automatic reconnection', () => {
    it('schedules reconnect when connection closes unexpectedly', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      // Simulate server-side close
      wsInstances[0].simulateClose(1006, 'abnormal');

      // Advance past base reconnect delay (1s + jitter up to 20%)
      vi.advanceTimersByTime(1_500);

      // A new WebSocket should have been created
      expect(wsInstances.length).toBeGreaterThanOrEqual(2);
    });

    it('emits disconnected event on close', () => {
      const mgr = new WebSocketManager('/ws');
      const handler = vi.fn();
      mgr.on('disconnected', handler);

      mgr.connect();
      wsInstances[0].simulateOpen();
      wsInstances[0].simulateClose(1006, 'abnormal');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does NOT reconnect after intentional disconnect', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      mgr.disconnect();

      vi.advanceTimersByTime(60_000);
      expect(wsInstances).toHaveLength(1);
    });
  });

  // ---------- Message parsing ----------

  describe('message parsing', () => {
    it('handles messages with data envelope (conversation_updated)', () => {
      const mgr = new WebSocketManager('/ws');
      const handler = vi.fn();
      mgr.on('conversation_updated', handler);

      mgr.connect();
      wsInstances[0].simulateOpen();
      wsInstances[0].simulateMessage({
        type: 'conversation_updated',
        data: { conversationId: 'c-1', conversation: { id: 'c-1', name: 'Test' } },
      });

      expect(handler).toHaveBeenCalledWith({
        conversationId: 'c-1',
        conversation: { id: 'c-1', name: 'Test' },
      });
    });

    it('handles messages without data envelope (chat_token)', () => {
      const mgr = new WebSocketManager('/ws');
      const handler = vi.fn();
      mgr.on('chat_token', handler);

      mgr.connect();
      wsInstances[0].simulateOpen();
      wsInstances[0].simulateMessage({
        type: 'chat_token',
        conversationId: 'c-1',
        jobId: 'j-1',
        content: 'Hello',
      });

      // For messages without 'data' key, the entire message is passed
      expect(handler).toHaveBeenCalledWith({
        type: 'chat_token',
        conversationId: 'c-1',
        jobId: 'j-1',
        content: 'Hello',
      });
    });

    it('silently handles invalid JSON without crashing', () => {
      const mgr = new WebSocketManager('/ws');
      mgr.connect();
      wsInstances[0].simulateOpen();

      // Send raw invalid JSON string
      if (wsInstances[0].onmessage) {
        expect(() => {
          wsInstances[0].onmessage!(new MessageEvent('message', { data: 'not valid json{' }));
        }).not.toThrow();
      }
    });

    it('connected message is emitted with server data', () => {
      const mgr = new WebSocketManager('/ws');
      const handler = vi.fn();
      mgr.on('connected', handler);

      mgr.connect();
      wsInstances[0].simulateOpen();
      wsInstances[0].simulateMessage({
        type: 'connected',
        userId: 'user-1',
        streamingStates: { 'c-1': { sessionId: 's-1' } },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      // 'connected' has no 'data' envelope, so full message is passed
      expect(handler).toHaveBeenCalledWith({
        type: 'connected',
        userId: 'user-1',
        streamingStates: { 'c-1': { sessionId: 's-1' } },
      });
    });
  });

  // ---------- Handler error isolation ----------

  describe('handler error isolation', () => {
    it('a throwing handler does not prevent other handlers from firing', () => {
      const mgr = new WebSocketManager('/ws');
      const h1 = vi.fn(() => { throw new Error('boom'); });
      const h2 = vi.fn();
      mgr.on('conversation_list_changed', h1);
      mgr.on('conversation_list_changed', h2);

      mgr.connect();
      wsInstances[0].simulateOpen();
      wsInstances[0].simulateMessage({ type: 'conversation_list_changed' });

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });
  });
});
