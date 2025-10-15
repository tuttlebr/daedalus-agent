import { IntermediateStep } from '@/types/intermediateSteps';

export interface SSEConfig {
  url: string;
  onMessage?: (data: any) => void;
  onIntermediateStep?: (step: IntermediateStep) => void;
  onChatToken?: (token: string) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
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
      console.log('SSE connection opened');
      this.reconnectAttempts = 0;
    };

    this.eventSource.onerror = (error) => {
      console.error('SSE error:', error);

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
        console.error('Error parsing intermediate step:', error);
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
        console.error('Error parsing chat token:', error);
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
      console.error('Max reconnection attempts reached');
      if (this.config.onClose) {
        this.config.onClose();
      }
      return;
    }

    this.reconnectAttempts++;
    const delay = (this.config.reconnectDelay || 1000) * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);

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
