export interface Message {
  id?: string;
  role: Role;
  content: string;
  intermediateSteps?: any;
  humanInteractionMessages?: any;
  errorMessages?: any;
  metadata?: {
    useDeepThinker?: boolean;
    [key: string]: any;
  };
  attachments?: Array<{
    content: string;
    type: string;
    imageRef?: {
      imageId: string;
      sessionId: string;
      mimeType?: string;
    };
  }>;
}

export type Role = 'assistant' | 'user' | 'agent' | 'system';

export interface ChatBody {
  chatCompletionURL?: string,
  messages?: Message[],
  additionalProps?: any
}

export interface Conversation {
  id: string;
  name: string;
  messages: Message[];
  folderId: string | null;
}
