/**
 * Tests for the ConnectionManager class (services/connectionManager.ts).
 *
 * We mock the WebSocketManager and EventSource so no real I/O occurs.
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

// ---- Mock WebSocketManager ----
const mockWsHandlers = new Map<string, Set<(data: any) => void>>();

const mockWsManager = {
  isConnected: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn((type: string, handler: (data: any) => void) => {
    let set = mockWsHandlers.get(type);
    if (!set) {
      set = new Set();
      mockWsHandlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }),
  subscribeToJob: vi.fn(),
  unsubscribeFromJob: vi.fn(),
  subscribeToChat: vi.fn(),
  unsubscribeFromChat: vi.fn(),
};

vi.mock('@/services/websocket', () => ({
  getWebSocketManager: vi.fn(() => mockWsManager),
  WebSocketManager: vi.fn(),
}));

// ---- Mock EventSource ----
class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  readyState = 0;
  onerror: ((ev: Event) => void) | null = null;
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (ev: MessageEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
  }

  close = vi.fn();

  // Test helper: simulate SSE event
  simulateEvent(type: string, data: any): void {
    const handlers = this.listeners.get(type);
    if (handlers) {
      for (const h of handlers) {
        h(new MessageEvent(type, { data: JSON.stringify(data) }));
      }
    }
  }

  // Test helper: simulate error
  simulateError(): void {
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }
}

// Helper to emit WS events in tests
function emitWsEvent(type: string, data?: any): void {
  const handlers = mockWsHandlers.get(type);
  if (handlers) {
    for (const h of handlers) {
      h(data);
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWsHandlers.clear();
  MockEventSource.instances = [];
  mockWsManager.isConnected = false;
  mockWsManager.connect.mockReset();
  mockWsManager.disconnect.mockReset();
  mockWsManager.on.mockImplementation((type: string, handler: (data: any) => void) => {
    let set = mockWsHandlers.get(type);
    if (!set) {
      set = new Set();
      mockWsHandlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  });

  (globalThis as any).EventSource = MockEventSource;
});

afterEach(() => {
  delete (globalThis as any).EventSource;
});

import { ConnectionManager, ConnectionMode } from '@/services/connectionManager';

describe('ConnectionManager', () => {
  // ---------- Initial state ----------

  describe('initial state', () => {
    it('starts in disconnected mode', () => {
      const cm = new ConnectionManager();
      expect(cm.mode).toBe('disconnected');
    });

    it('isConnected returns false when disconnected', () => {
      const cm = new ConnectionManager();
      expect(cm.isConnected).toBe(false);
    });
  });

  // ---------- connect() - WebSocket first ----------

  describe('connect() - WebSocket success', () => {
    it('tries WebSocket first and sets mode to websocket on success', async () => {
      vi.useFakeTimers();
      const cm = new ConnectionManager();

      // Simulate WS connecting successfully
      mockWsManager.connect.mockImplementation(() => {
        // Fire the connected event asynchronously
        setTimeout(() => emitWsEvent('connected', { userId: 'u-1' }), 10);
      });

      const connectPromise = cm.connect();

      // Fast-forward past the setTimeout
      await vi.advanceTimersByTimeAsync(50);
      await connectPromise;

      expect(cm.mode).toBe('websocket');
      expect(cm.isConnected).toBe(true);
      expect(mockWsManager.connect).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('connect() - WebSocket timeout falls back to SSE', () => {
    it('falls back to SSE when WS does not connect within 5 seconds', async () => {
      vi.useFakeTimers();
      const cm = new ConnectionManager();

      // WS connect never fires 'connected'
      mockWsManager.connect.mockImplementation(() => {});

      const connectPromise = cm.connect();

      // Advance past WS_CONNECT_TIMEOUT (5s)
      await vi.advanceTimersByTimeAsync(5_500);
      await connectPromise;

      expect(cm.mode).toBe('sse');
      expect(cm.isConnected).toBe(true);
      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.instances[0].url).toBe('/api/sync/stream');

      vi.useRealTimers();
    });
  });

  describe('connect() - WS disconnect during attempt falls back to SSE', () => {
    it('falls back to SSE when WS fires disconnected during initial attempt', async () => {
      vi.useFakeTimers();
      const cm = new ConnectionManager();

      mockWsManager.connect.mockImplementation(() => {
        setTimeout(() => emitWsEvent('disconnected'), 10);
      });

      const connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(50);
      await connectPromise;

      expect(cm.mode).toBe('sse');
      expect(MockEventSource.instances).toHaveLength(1);

      vi.useRealTimers();
    });
  });

  // ---------- wsFailureCount tracking ----------

  describe('wsFailureCount tracking', () => {
    it('increments wsFailureCount on each WS failure', async () => {
      vi.useFakeTimers();

      // First attempt - WS times out
      const cm = new ConnectionManager();
      mockWsManager.connect.mockImplementation(() => {});

      let connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(5_500);
      await connectPromise;

      expect(cm.mode).toBe('sse');

      // Disconnect to allow next connect
      cm.disconnect();

      // Second attempt
      connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(5_500);
      await connectPromise;
      cm.disconnect();

      // Third attempt
      connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(5_500);
      await connectPromise;
      cm.disconnect();

      // Fourth attempt - should skip WS entirely (3 failures reached)
      mockWsManager.connect.mockClear();
      connectPromise = cm.connect();
      // Should resolve immediately with SSE, no need to wait for WS timeout
      await vi.advanceTimersByTimeAsync(100);
      await connectPromise;

      // WebSocket connect should NOT have been called on the 4th attempt
      expect(mockWsManager.connect).not.toHaveBeenCalled();
      expect(cm.mode).toBe('sse');

      vi.useRealTimers();
    });

    it('resets wsFailureCount on successful WS connection', async () => {
      vi.useFakeTimers();
      const cm = new ConnectionManager();

      // First attempt: fail WS
      mockWsManager.connect.mockImplementation(() => {});
      let connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(5_500);
      await connectPromise;
      cm.disconnect();

      // Second attempt: succeed WS
      mockWsManager.connect.mockImplementation(() => {
        setTimeout(() => emitWsEvent('connected', { userId: 'u-1' }), 10);
      });
      connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(50);
      await connectPromise;

      expect(cm.mode).toBe('websocket');

      // After success, the failure count should be 0.
      // Disconnect and try again - it should attempt WS, not skip it
      cm.disconnect();
      mockWsManager.connect.mockClear();
      mockWsManager.connect.mockImplementation(() => {
        setTimeout(() => emitWsEvent('connected', { userId: 'u-1' }), 10);
      });
      connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(50);
      await connectPromise;

      expect(mockWsManager.connect).toHaveBeenCalled();
      expect(cm.mode).toBe('websocket');

      vi.useRealTimers();
    });
  });

  // ---------- on() handler registration ----------

  describe('on()', () => {
    it('registers handlers that receive events', async () => {
      vi.useFakeTimers();
      const cm = new ConnectionManager();
      const handler = vi.fn();

      cm.on('conversation_updated', handler);

      // Connect via SSE fallback
      mockWsManager.connect.mockImplementation(() => {});
      const connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(5_500);
      await connectPromise;

      // Simulate SSE event
      MockEventSource.instances[0].simulateEvent('conversation_updated', {
        conversationId: 'c-1',
      });

      expect(handler).toHaveBeenCalledWith({ conversationId: 'c-1' });

      vi.useRealTimers();
    });

    it('returns an unsubscribe function', () => {
      const cm = new ConnectionManager();
      const handler = vi.fn();
      const unsub = cm.on('conversation_deleted', handler);

      expect(typeof unsub).toBe('function');
    });

    it('unsubscribe prevents further calls to the handler', async () => {
      vi.useFakeTimers();
      const cm = new ConnectionManager();
      const handler = vi.fn();
      const unsub = cm.on('conversation_updated', handler);

      unsub();

      // Connect via SSE
      mockWsManager.connect.mockImplementation(() => {});
      const connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(5_500);
      await connectPromise;

      MockEventSource.instances[0].simulateEvent('conversation_updated', {
        conversationId: 'c-1',
      });

      expect(handler).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('wires handlers to WebSocket when in WS mode', async () => {
      vi.useFakeTimers();
      const cm = new ConnectionManager();
      const handler = vi.fn();

      // Register before connecting
      cm.on('streaming_started', handler);

      // Connect via WS
      mockWsManager.connect.mockImplementation(() => {
        setTimeout(() => emitWsEvent('connected', { userId: 'u-1' }), 10);
      });
      const connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(50);
      await connectPromise;

      expect(cm.mode).toBe('websocket');

      // The handler should be wired to the WS manager
      // (wireHandlersToWs is called on successful WS connect)
      // We can verify by checking that on() was called with 'streaming_started'
      const onCalls = mockWsManager.on.mock.calls;
      const streamingStartedCalls = onCalls.filter((c: any[]) => c[0] === 'streaming_started');
      expect(streamingStartedCalls.length).toBeGreaterThan(0);

      vi.useRealTimers();
    });

    it('registers on WS manager if already connected via WS', async () => {
      vi.useFakeTimers();
      const cm = new ConnectionManager();

      // Connect via WS first
      mockWsManager.connect.mockImplementation(() => {
        setTimeout(() => emitWsEvent('connected', { userId: 'u-1' }), 10);
      });
      const connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(50);
      await connectPromise;

      // Now register a handler after WS is connected
      mockWsManager.on.mockClear();
      const handler = vi.fn();
      cm.on('chat_token', handler);

      // Should have been immediately registered on WS manager
      expect(mockWsManager.on).toHaveBeenCalledWith('chat_token', handler);

      vi.useRealTimers();
    });
  });

  // ---------- disconnect() ----------

  describe('disconnect()', () => {
    it('disconnects WebSocket when in WS mode', async () => {
      vi.useFakeTimers();
      const cm = new ConnectionManager();

      mockWsManager.connect.mockImplementation(() => {
        setTimeout(() => emitWsEvent('connected', { userId: 'u-1' }), 10);
      });
      const connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(50);
      await connectPromise;

      cm.disconnect();

      expect(mockWsManager.disconnect).toHaveBeenCalled();
      expect(cm.mode).toBe('disconnected');
      expect(cm.isConnected).toBe(false);

      vi.useRealTimers();
    });

    it('closes EventSource when in SSE mode', async () => {
      vi.useFakeTimers();
      const cm = new ConnectionManager();

      mockWsManager.connect.mockImplementation(() => {});
      const connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(5_500);
      await connectPromise;

      expect(cm.mode).toBe('sse');

      cm.disconnect();

      expect(MockEventSource.instances[0].close).toHaveBeenCalled();
      expect(cm.mode).toBe('disconnected');

      vi.useRealTimers();
    });

    it('is safe to call when already disconnected', () => {
      const cm = new ConnectionManager();
      expect(() => cm.disconnect()).not.toThrow();
      expect(cm.mode).toBe('disconnected');
    });
  });

  // ---------- SSE event forwarding ----------

  describe('SSE event forwarding', () => {
    it('forwards all configured SSE event types to handlers', async () => {
      vi.useFakeTimers();
      const cm = new ConnectionManager();

      const connectedHandler = vi.fn();
      const updatedHandler = vi.fn();
      const deletedHandler = vi.fn();
      const listChangedHandler = vi.fn();
      const streamStartedHandler = vi.fn();
      const streamEndedHandler = vi.fn();

      cm.on('connected', connectedHandler);
      cm.on('conversation_updated', updatedHandler);
      cm.on('conversation_deleted', deletedHandler);
      cm.on('conversation_list_changed', listChangedHandler);
      cm.on('streaming_started', streamStartedHandler);
      cm.on('streaming_ended', streamEndedHandler);

      // Connect via SSE
      mockWsManager.connect.mockImplementation(() => {});
      const connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(5_500);
      await connectPromise;

      const es = MockEventSource.instances[0];
      es.simulateEvent('connected', { userId: 'u-1' });
      es.simulateEvent('conversation_updated', { conversationId: 'c-1' });
      es.simulateEvent('conversation_deleted', { conversationId: 'c-2' });
      es.simulateEvent('conversation_list_changed', {});
      es.simulateEvent('streaming_started', { conversationId: 'c-1' });
      es.simulateEvent('streaming_ended', { conversationId: 'c-1' });

      expect(connectedHandler).toHaveBeenCalledWith({ userId: 'u-1' });
      expect(updatedHandler).toHaveBeenCalledWith({ conversationId: 'c-1' });
      expect(deletedHandler).toHaveBeenCalledWith({ conversationId: 'c-2' });
      expect(listChangedHandler).toHaveBeenCalledTimes(1);
      expect(streamStartedHandler).toHaveBeenCalledWith({ conversationId: 'c-1' });
      expect(streamEndedHandler).toHaveBeenCalledWith({ conversationId: 'c-1' });

      vi.useRealTimers();
    });

    it('SSE error sets mode to disconnected and emits disconnected', async () => {
      vi.useFakeTimers();
      const cm = new ConnectionManager();
      const handler = vi.fn();
      cm.on('disconnected', handler);

      mockWsManager.connect.mockImplementation(() => {});
      const connectPromise = cm.connect();
      await vi.advanceTimersByTimeAsync(5_500);
      await connectPromise;

      expect(cm.mode).toBe('sse');

      MockEventSource.instances[0].simulateError();

      expect(cm.mode).toBe('disconnected');
      expect(handler).toHaveBeenCalledWith(undefined);

      vi.useRealTimers();
    });
  });
});
