import type { ImageContext } from './imageBrief';
import { IntermediateStep } from './intermediateSteps';

export interface MessageError {
  message: string;
  category?:
    | 'network'
    | 'timeout'
    | 'server'
    | 'rate_limit'
    | 'authentication'
    | 'unknown';
  details?: string;
  timestamp: number;
  recoverable: boolean;
}

export interface Message {
  id?: string;
  role: Role;
  content: string;
  /** Total elapsed job time, including agent and tool work, in milliseconds. */
  generationDurationMs?: number;
  intermediateSteps?: IntermediateStep[];
  humanInteractionMessages?: any;
  errorMessages?: MessageError;
  metadata?: {
    [key: string]: any;
  };
  attachments?: Array<{
    content: string;
    type: string;
    imageContext?: ImageContext;
    imageRef?: {
      imageId: string;
      sessionId: string;
      userId?: string;
      mimeType?: string;
    };
    imageRefs?: Array<{
      imageId: string;
      sessionId: string;
      userId?: string;
      mimeType?: string;
    }>;
    videoRef?: {
      videoId: string;
      sessionId: string;
      userId?: string;
      filename?: string;
      mimeType?: string;
    };
    videoRefs?: Array<{
      videoId: string;
      sessionId: string;
      userId?: string;
      filename?: string;
      mimeType?: string;
    }>;
    documentRef?: {
      documentId: string;
      sessionId: string;
      userId?: string;
      filename?: string;
      mimeType?: string;
    };
  }>;
}

type Role = 'assistant' | 'user' | 'agent' | 'system';

/** Title of a conversation that has not been named yet, in every layer. */
export const DEFAULT_CONVERSATION_TITLE = 'New Conversation';

export interface Conversation {
  id: string;
  name: string;
  messages: Message[];
  folderId: string | null;
  updatedAt?: number;
  isPartial?: boolean;
  error?: string;
  completedAt?: number;
  /**
   * The server revision this copy was derived from: an opaque concurrency
   * token that clients compare for equality and send back unchanged.
   */
  revision?: string;
}
