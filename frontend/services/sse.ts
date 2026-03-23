import { IntermediateStep } from '@/types/intermediateSteps';
import { Logger } from '@/utils/logger';

const logger = new Logger('SSE');

// Event types for real-time sync
export type SyncEventType =
  | 'conversation_updated'
  | 'streaming_started'
  | 'streaming_ended'
  | 'session_event'
  | 'connected'
  | 'heartbeat';

export interface SSEConfig {
  url: string;
  onMessage?: (data: any) => void;
  onIntermediateStep?: (step: IntermediateStep) => void;
  onChatToken?: (token: string) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
  // New sync event handlers
  onConversationUpdated?: (data: { conversationId: string; conversation: any }) => void;
  onStreamingStateChanged?: (data: { conversationId: string; isStreaming: boolean }) => void;
  onSessionEvent?: (data: any) => void;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
}

export class SSEClient {
  private eventSource: EventSource | null = null;
  private config: SSEConfig;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isIntentionallyClosed = false;

  constructor(config: SSEConfig) {
    this.config = {
      reconnectDelay: 1000,
      maxReconnectAttempts: 5,
      ...config
    };
  }

  connect(): void {
    if (this.eventSource) {
      this.close();
    }

    this.isIntentionallyClosed = false;
    this.eventSource = new EventSource(this.config.url);

    this.eventSource.onopen = () => {
      logger.info('SSE connection opened');
      this.reconnectAttempts = 0;
    };

    this.eventSource.onerror = (error) => {
      logger.error('SSE error', error);

      if (this.config.onError) {
        this.config.onError(new Error('SSE connection error'));
      }

      if (!this.isIntentionallyClosed) {
        this.attemptReconnect();
      }
    };

    // Handle intermediate step events
    this.eventSource.addEventListener('intermediate_step', (event) => {
      try {
        const step: IntermediateStep = JSON.parse(event.data);
        if (this.config.onIntermediateStep) {
          this.config.onIntermediateStep(step);
        }
      } catch (error) {
        logger.error('Error parsing intermediate step', error);
      }
    });

    // Handle chat token events
    this.eventSource.addEventListener('chat_token', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (this.config.onChatToken && data.token) {
          this.config.onChatToken(data.token);
        }
      } catch (error) {
        logger.error('Error parsing chat token', error);
      }
    });

    // Handle conversation updated events (for real-time sync)
    this.eventSource.addEventListener('conversation_updated', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (this.config.onConversationUpdated) {
          this.config.onConversationUpdated(data);
        }
      } catch (error) {
        logger.error('Error parsing conversation_updated event', error);
      }
    });

    // Handle streaming state events (for real-time sync)
    this.eventSource.addEventListener('streaming_started', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (this.config.onStreamingStateChanged) {
          this.config.onStreamingStateChanged({ ...data, isStreaming: true });
        }
      } catch (error) {
        logger.error('Error parsing streaming_started event', error);
      }
    });

    this.eventSource.addEventListener('streaming_ended', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (this.config.onStreamingStateChanged) {
          this.config.onStreamingStateChanged({ ...data, isStreaming: false });
        }
      } catch (error) {
        logger.error('Error parsing streaming_ended event', error);
      }
    });

    // Handle session events (for multi-session awareness)
    this.eventSource.addEventListener('session_event', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (this.config.onSessionEvent) {
          this.config.onSessionEvent(data);
        }
      } catch (error) {
        logger.error('Error parsing session_event', error);
      }
    });

    // Handle generic message events
    this.eventSource.onmessage = (event) => {
      if (this.config.onMessage) {
        try {
          const data = JSON.parse(event.data);
          this.config.onMessage(data);
        } catch (error) {
          // If not JSON, pass raw data
          this.config.onMessage(event.data);
        }
      }
    };
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= (this.config.maxReconnectAttempts || 5)) {
      logger.error('Max reconnection attempts reached');
      if (this.config.onClose) {
        this.config.onClose();
      }
      return;
    }

    this.reconnectAttempts++;
    const delay = (this.config.reconnectDelay || 1000) * Math.pow(2, this.reconnectAttempts - 1);

    logger.info(`Attempting to reconnect in ${delay}ms`, { attempt: this.reconnectAttempts });

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  close(): void {
    this.isIntentionallyClosed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.eventSource) {
      // Remove all named event listeners before closing to prevent memory leaks
      this.eventSource.onopen = null;
      this.eventSource.onerror = null;
      this.eventSource.onmessage = null;
      this.eventSource.close();
      this.eventSource = null;
    }

    if (this.config.onClose) {
      this.config.onClose();
    }
  }

  isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN;
  }
}

// Helper function to create SSE URL with query parameters
export function createSSEUrl(baseUrl: string, params: Record<string, any>): string {
  const url = new URL(baseUrl, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value));
    }
  });
  return url.toString();
}
