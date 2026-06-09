import type {
  MilvusCollectionProvenance,
  MilvusCollectionScope,
} from '@/utils/app/milvusCollections';

export interface AsyncJobRequest {
  jobId: string;
  natBaseUrl: string;
  natSessionId?: string;
  executionMode?: 'stream' | 'nat_async' | 'document_ingest';
  natMessages?: any[];
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

export interface NatAsyncJobResponse {
  job_id: string;
  status: 'submitted' | 'running' | 'success' | 'failure' | 'interrupted';
  error: string | null;
  output: { value: string } | string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
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
