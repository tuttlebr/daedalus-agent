/**
 * Connection Manager Facade
 *
 * Attempts WebSocket first. On failure (e.g., corporate proxy strips
 * upgrade headers), falls back to existing SSE. Transparent to consumers.
 *
 * Usage:
 *   import { getConnectionManager } from '@/services/connectionManager';
 *   const cm = getConnectionManager();
 *   cm.connect();
 *   cm.on('conversation_updated', (data) => { ... });
 */

import { getWebSocketManager, WebSocketManager } from './websocket';
import { Logger } from '@/utils/logger';

const logger = new Logger('ConnectionManager');

type MessageHandler = (data: any) => void;

export type ConnectionMode = 'websocket' | 'sse' | 'disconnected';

const WS_CONNECT_TIMEOUT = 5_000; // 5s to establish WebSocket before falling back
const WS_FAILURE_THRESHOLD = 3; // Skip WS after this many consecutive failures

export class ConnectionManager {
  private wsManager: WebSocketManager;
  private handlers = new Map<string, Set<MessageHandler>>();
  private wsUnsubs: Array<() => void> = [];
  private eventSource: EventSource | null = null;
  private _mode: ConnectionMode = 'disconnected';
  private fallbackAttempted = false;
  private wsFailureCount = 0;

  constructor() {
    this.wsManager = getWebSocketManager();
  }

  get mode(): ConnectionMode {
    return this._mode;
  }

  get isConnected(): boolean {
    return this._mode !== 'disconnected';
  }

  async connect(): Promise<void> {
    // Skip WS if too many consecutive failures
    if (this.wsFailureCount >= WS_FAILURE_THRESHOLD) {
      logger.info(`Skipping WebSocket (${this.wsFailureCount} consecutive failures) — using SSE`);
      this.connectSSE();
      return;
    }

    // Try WebSocket first
    try {
      const connected = await this.tryWebSocket();
      if (connected) {
        this._mode = 'websocket';
        this.wsFailureCount = 0; // Reset on success
        logger.info('Connected via WebSocket');
        return;
      }
    } catch {
      logger.warn('WebSocket connection failed');
    }

    this.wsFailureCount++;
    // Fall back to SSE
    this.connectSSE();
  }

  disconnect(): void {
    if (this._mode === 'websocket') {
      this.wsManager.disconnect();
      this.wsUnsubs.forEach((unsub) => unsub());
      this.wsUnsubs = [];
    } else if (this._mode === 'sse') {
      this.disconnectSSE();
    }
    this._mode = 'disconnected';
  }

  on(type: string, handler: MessageHandler): () => void {
    let typeHandlers = this.handlers.get(type);
    if (!typeHandlers) {
      typeHandlers = new Set();
      this.handlers.set(type, typeHandlers);
    }
    typeHandlers.add(handler);

    // If already connected via WebSocket, register on the manager too
    if (this._mode === 'websocket') {
      const unsub = this.wsManager.on(type, handler);
      this.wsUnsubs.push(unsub);
    }

    return () => {
      typeHandlers!.delete(handler);
      if (typeHandlers!.size === 0) {
        this.handlers.delete(type);
      }
    };
  }

  // ---------- Private ----------

  private async tryWebSocket(): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, WS_CONNECT_TIMEOUT);

      // Listen for successful connection
      const unsub = this.wsManager.on('connected', () => {
        clearTimeout(timeout);
        unsub();
        // Wire all existing handlers to WebSocket
        this.wireHandlersToWs();
        resolve(true);
      });

      // Listen for disconnect (connection failed)
      const unsubDisconnect = this.wsManager.on('disconnected', () => {
        clearTimeout(timeout);
        unsubDisconnect();
        if (this._mode === 'disconnected') {
          resolve(false);
        }
      });

      this.wsUnsubs.push(unsub, unsubDisconnect);
      this.wsManager.connect();
    });
  }

  private wireHandlersToWs(): void {
    for (const [type, handlers] of this.handlers) {
      for (const handler of handlers) {
        const unsub = this.wsManager.on(type, handler);
        this.wsUnsubs.push(unsub);
      }
    }
  }

  private connectSSE(): void {
    if (typeof window === 'undefined') return;

    this.fallbackAttempted = true;
    logger.info('Falling back to SSE');

    this.eventSource = new EventSource('/api/sync/stream');

    // Map SSE events to our handler system
    const sseEventTypes = [
      'connected', 'conversation_updated', 'conversation_deleted',
      'conversation_list_changed', 'streaming_started', 'streaming_ended',
      'heartbeat',
    ];

    for (const eventType of sseEventTypes) {
      this.eventSource.addEventListener(eventType, (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data);
          this.emit(eventType, data);
        } catch {
          this.emit(eventType, undefined);
        }
      });
    }

    this.eventSource.onerror = () => {
      logger.warn('SSE connection error');
      this._mode = 'disconnected';
      this.emit('disconnected', undefined);
    };

    this._mode = 'sse';
  }

  private disconnectSSE(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  private emit(type: string, data: any): void {
    const typeHandlers = this.handlers.get(type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          handler(data);
        } catch (err) {
          logger.error(`Error in ${type} handler`, err);
        }
      }
    }
  }
}

// Singleton
let instance: ConnectionManager | null = null;

export function getConnectionManager(): ConnectionManager {
  if (!instance) {
    instance = new ConnectionManager();
  }
  return instance;
}
