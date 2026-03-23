import { getPublisher, channels } from '@/pages/api/session/redis';
import { Conversation } from '@/types/chat';

export type SyncEventType =
  | 'conversation_updated'
  | 'conversation_deleted'
  | 'conversation_list_changed'
  | 'selected_conversation_changed'
  | 'streaming_started'
  | 'streaming_ended'
  | 'heartbeat'
  | 'session_registered'
  | 'session_unregistered';

export interface SyncEvent {
  type: SyncEventType;
  timestamp: number;
  data: any;
}

export interface ConversationUpdateEvent extends SyncEvent {
  type: 'conversation_updated';
  data: {
    conversationId: string;
    conversation: Conversation;
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

// Publish a conversation update to all user sessions
export async function publishConversationUpdate(
  userId: string,
  conversation: Conversation
): Promise<void> {
  try {
    const publisher = getPublisher();
    const channel = channels.userUpdates(userId);

    const event: ConversationUpdateEvent = {
      type: 'conversation_updated',
      timestamp: Date.now(),
      data: {
        conversationId: conversation.id,
        conversation,
      },
    };

    await publisher.publish(channel, JSON.stringify(event));
  } catch (error) {
    console.error('Failed to publish conversation update:', error);
  }
}

// Publish streaming state change to all user sessions
export async function publishStreamingState(
  userId: string,
  conversationId: string,
  isStreaming: boolean,
  sessionId: string = ''
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
  event: SyncEvent
): Promise<void> {
  try {
    const publisher = getPublisher();
    const channel = channels.userUpdates(userId);
    await publisher.publish(channel, JSON.stringify(event));
  } catch (error) {
    console.error('Failed to publish sync event:', error);
  }
}
