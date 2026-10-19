import { Conversation } from '@/types/chat';

import { getPublisher, channels } from '@/server/session/redis';

export type SyncEventType =
  | 'conversation_updated'
  | 'conversation_deleted'
  | 'streaming_started'
  | 'streaming_ended'
  | 'autonomy_status'
  | 'autonomy_run_event'
  | 'autonomy_feed_updated';

export interface SyncEvent {
  type: SyncEventType;
  timestamp: number;
  data: any;
}

/**
 * A saved conversation changed. Browser saves publish only its id and the
 * committed revision, and receivers read the record. Worker finalization
 * (server/chat/finalization.ts) also includes the conversation it saved.
 */
export interface ConversationUpdateEvent extends SyncEvent {
  type: 'conversation_updated';
  data: {
    conversationId: string;
    revision?: string;
    conversation?: Conversation;
  };
}

export interface StreamingStateEvent extends SyncEvent {
  type: 'streaming_started' | 'streaming_ended';
  data: {
    conversationId: string;
    sessionId: string;
    isStreaming: boolean;
  };
}

// Publish a conversation update to all user sessions. Failures reach the
// caller, which reports them to the notifying browser.
export async function publishConversationUpdate(
  userId: string,
  conversationId: string,
  revision?: string,
): Promise<void> {
  const event: ConversationUpdateEvent = {
    type: 'conversation_updated',
    timestamp: Date.now(),
    data: { conversationId, ...(revision ? { revision } : {}) },
  };
  await getPublisher().publish(
    channels.userUpdates(userId),
    JSON.stringify(event),
  );
}

// Publish streaming state change to all user sessions
export async function publishStreamingState(
  userId: string,
  conversationId: string,
  isStreaming: boolean,
  sessionId: string = '',
): Promise<void> {
  try {
    const publisher = getPublisher();
    const channel = channels.userUpdates(userId);

    const event: StreamingStateEvent = {
      type: isStreaming ? 'streaming_started' : 'streaming_ended',
      timestamp: Date.now(),
      data: {
        conversationId,
        sessionId,
        isStreaming,
      },
    };

    await publisher.publish(channel, JSON.stringify(event));
  } catch (error) {
    console.error('Failed to publish streaming state:', error);
  }
}

// Publish a generic sync event
export async function publishSyncEvent(
  userId: string,
  event: SyncEvent,
): Promise<void> {
  try {
    const publisher = getPublisher();
    const channel = channels.userUpdates(userId);
    await publisher.publish(channel, JSON.stringify(event));
  } catch (error) {
    console.error('Failed to publish sync event:', error);
  }
}
