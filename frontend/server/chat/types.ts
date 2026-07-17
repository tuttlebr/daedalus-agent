import type {
  MilvusCollectionProvenance,
  MilvusCollectionScope,
} from '@/utils/app/milvusCollections';

export interface AsyncJobRequest {
  jobId: string;
  natBaseUrl: string;
  natSessionId?: string;
  timezone?: string;
  executionMode: 'stream' | 'document_ingest';
  documentIngest?: DocumentIngestJobRequest;
  messages: any[];
  additionalProps: any;
  userId: string;
  conversationId?: string;
  conversationName?: string;
  turnId?: string;
  assistantMessageId?: string;
}

export interface DocumentIngestJobRequest {
  documentRefs: any[];
  collectionName: string;
  collectionScope: MilvusCollectionScope;
  provenance: MilvusCollectionProvenance;
  username: string;
}

export interface DocumentIngestProgress {
  completed: number;
  total: number;
  currentDoc?: string;
  currentIndex?: number;
  percent: number;
  phase?: string;
  message?: string;
  chunks?: number;
  pages?: number;
  failures?: number;
  attempt?: number;
}

export interface OAuthRequest {
  id: string;
  authUrl: string;
  oauthState?: string;
  service?: string;
}

export interface AsyncJobStatus {
  jobId: string;
  status: 'pending' | 'streaming' | 'oauth_required' | 'completed' | 'error';
  partialResponse?: string;
  fullResponse?: string;
  intermediateSteps?: any[];
  error?: string;
  authUrl?: string;
  oauthState?: string;
  oauthRequests?: OAuthRequest[];
  progress?: number;
  ingestProgress?: DocumentIngestProgress;
  createdAt: number;
  updatedAt: number;
  conversationId?: string;
  finalizedAt?: number;
  turnId?: string;
  assistantMessageId?: string;
}

export class ApiRouteError extends Error {
  status: number;
  reason: string;

  constructor(status: number, message: string, reason: string) {
    super(message);
    this.name = 'ApiRouteError';
    this.status = status;
    this.reason = reason;
  }
}
