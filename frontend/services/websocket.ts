/**
 * WebSocket Client Manager
 *
 * Single WebSocket connection that handles all real-time communication:
 * - Conversation updates (replaces SSE)
 * - Job status push (replaces polling)
 * - Streaming state changes
 *
 * Battery-aware: disconnects when backgrounded (unless streaming),
 * extends reconnect delay on low battery.
 */

import { Logger } from '@/utils/logger';
import { shouldRunExpensiveOperation } from '@/utils/app/visibilityAwareTimer';

const logger = new Logger('WebSocket');

// ---------- Types ----------

// Client → Server
export type ClientMessage =
  | { type: 'ping' }
  | { type: 'subscribe_job'; jobId: string }
  | { type: 'unsubscribe_job'; jobId: string }
  | { type: 'subscribe_chat'; conversationId: string }
  | { type: 'unsubscribe_chat'; conversationId: string };

// Server → Client
export type ServerMessage =
  | { type: 'pong'; ts: number }
  | { type: 'connected'; userId: string; streamingStates: Record<string, any> }
  | { type: 'conversation_updated'; data: { conversationId: string; conversation: any } }
  | { type: 'conversation_deleted'; data: { conversationId: string } }
  | { type: 'conversation_list_changed' }
  | { type: 'selected_conversation_changed'; data: { conversationId: string } }
  | { type: 'streaming_started'; data: { conversationId: string; sessionId: string } }
  | { type: 'streaming_ended'; data: { conversationId: string; sessionId: string } }
  | { type: 'chat_token'; conversationId: string; jobId: string; content: string; intermediateSteps?: any[] }
  | { type: 'chat_intermediate_step'; conversationId: string; jobId: string; step: any }
  | { type: 'chat_complete'; conversationId: string; jobId: string; fullResponse: string; intermediateSteps?: any[] }
  | { type: 'job_status'; data: any }
  | { type: 'error'; message: string };

type MessageHandler = (data: any) => void;

// ---------- WebSocket Manager ----------

const PING_INTERVAL = 30_000; // Client sends ping every 30s
const PONG_TIMEOUT = 60_000; // Reconnect if no pong in 60s
const BASE_RECONNECT_DELAY = 1_000; // 1s initial
const MAX_RECONNECT_DELAY = 30_000; // 30s cap
const LOW_BATTERY_RECONNECT_DELAY = 60_000; // 60s when battery < 20%
const JITTER_FACTOR = 0.2; // 20% jitter on reconnect delay
const MAX_RECONNECT_ATTEMPTS = 20; // Stop after 20 attempts (~10 min at max delay)

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers = new Map<string, Set<MessageHandler>>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private _isConnected = false;
  private subscribedJobs = new Set<string>();
  private subscribedChats = new Set<string>();

  constructor(url: string = '/ws') {
    this.url = url;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.intentionalClose = false;

    try {
      // Build absolute WebSocket URL
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = this.url.startsWith('ws') ? this.url : `${protocol}//${window.location.host}${this.url}`;

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        logger.info('WebSocket connected');
        this._isConnected = true;
        this.reconnectAttempts = 0;
        this.startPing();

        // Re-subscribe to any jobs that were active before disconnect
        for (const jobId of this.subscribedJobs) {
          this.send({ type: 'subscribe_job', jobId });
        }

        // Re-subscribe to any chat token channels that were active before disconnect
        for (const conversationId of this.subscribedChats) {
          this.send({ type: 'subscribe_chat', conversationId });
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: ServerMessage = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch (err) {
          logger.error('Failed to parse WebSocket message', err);
        }
      };

      this.ws.onclose = (event) => {
        logger.info(`WebSocket closed: code=${event.code} reason=${event.reason}`);
        this._isConnected = false;
        this.stopPing();

        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }

        this.emit('disconnected', undefined);
      };

      this.ws.onerror = () => {
        logger.warn('WebSocket error');
        // onclose will fire after this
      };
    } catch (err) {
      logger.error('Failed to create WebSocket', err);
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopPing();
    this.cancelReconnect();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this._isConnected = false;
  }

  // Register a handler for a specific message type
  on(type: string, handler: MessageHandler): () => void {
    let typeHandlers = this.handlers.get(type);
    if (!typeHandlers) {
      typeHandlers = new Set();
      this.handlers.set(type, typeHandlers);
    }
    typeHandlers.add(handler);

    // Return unsubscribe function
    return () => {
      typeHandlers!.delete(handler);
      if (typeHandlers!.size === 0) {
        this.handlers.delete(type);
      }
    };
  }

  // Subscribe to job status updates
  subscribeToJob(jobId: string): void {
    this.subscribedJobs.add(jobId);
    if (this._isConnected) {
      this.send({ type: 'subscribe_job', jobId });
    }
  }

  // Unsubscribe from job status updates
  unsubscribeFromJob(jobId: string): void {
    this.subscribedJobs.delete(jobId);
    if (this._isConnected) {
      this.send({ type: 'unsubscribe_job', jobId });
    }
  }

  // Subscribe to chat token streaming for a conversation
  subscribeToChat(conversationId: string): void {
    this.subscribedChats.add(conversationId);
    if (this._isConnected) {
      this.send({ type: 'subscribe_chat', conversationId });
    }
  }

  // Unsubscribe from chat token streaming
  unsubscribeFromChat(conversationId: string): void {
    this.subscribedChats.delete(conversationId);
    if (this._isConnected) {
      this.send({ type: 'unsubscribe_chat', conversationId });
    }
  }

  // ---------- Private ----------

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: ServerMessage): void {
    // Handle pong: reset timeout
    if (msg.type === 'pong') {
      this.resetPongTimeout();
      return;
    }

    this.emit(msg.type, 'data' in msg ? (msg as any).data : msg);
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

  private startPing(): void {
    this.stopPing();

    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
      this.startPongTimeout();
    }, PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private startPongTimeout(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      logger.warn('Pong timeout - reconnecting');
      if (this.ws) {
        this.ws.close(4003, 'Pong timeout');
      }
    }, PONG_TIMEOUT);
  }

  private resetPongTimeout(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async scheduleReconnect(): Promise<void> {
    this.cancelReconnect();

    // Stop after max attempts
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.warn(`Max reconnection attempts reached (${MAX_RECONNECT_ATTEMPTS}) - stopping auto-reconnect`);
      this.emit('max_reconnect_reached', { attempts: this.reconnectAttempts });
      return;
    }

    // Battery-aware delay
    let delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY
    );

    // Check battery status
    try {
      if ('getBattery' in navigator) {
        const battery = await (navigator as any).getBattery();
        const level = battery.level * 100;

        if (level < 10 && !battery.charging) {
          // Critical battery: don't auto-reconnect
          logger.warn('Battery critical (<10%) - stopping auto-reconnect');
          this.emit('battery_critical', { level });
          return;
        }

        if (level < 20 && !battery.charging) {
          delay = Math.max(delay, LOW_BATTERY_RECONNECT_DELAY);
        }
      }
    } catch {
      // Battery API not available
    }

    // Add jitter (±20%)
    const jitter = delay * JITTER_FACTOR * (Math.random() * 2 - 1);
    delay = Math.round(delay + jitter);

    this.reconnectAttempts++;
    logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}

// Singleton instance
let instance: WebSocketManager | null = null;

export function getWebSocketManager(): WebSocketManager {
  if (!instance) {
    instance = new WebSocketManager('/ws');
  }
  return instance;
}
