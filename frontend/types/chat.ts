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
  intermediateSteps?: IntermediateStep[];
  humanInteractionMessages?: any;
  errorMessages?: MessageError;
  metadata?: {
    [key: string]: any;
  };
  attachments?: Array<{
    content: string;
    type: string;
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
    vttRef?: {
      vttId: string;
      sessionId: string;
      filename?: string;
      mimeType?: string;
    };
  }>;
}

type Role = 'assistant' | 'user' | 'agent' | 'system';

export interface Conversation {
  id: string;
  name: string;
  messages: Message[];
  folderId: string | null;
  updatedAt?: number;
  isPartial?: boolean;
  error?: string;
  completedAt?: number;
}
