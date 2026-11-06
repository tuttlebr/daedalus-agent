import type {
  MilvusCollectionProvenance,
  MilvusCollectionScope,
} from '@/utils/app/milvusCollections';

import type { ModelProfile } from '@/types/modelProfile';

export interface ChatAdditionalProps {
  model_profile?: ModelProfile;
  // Existing caller extensions retain their wire format.
  [key: string]: any;
}

/**
 * A run submitted through the OpenAI or Anthropic compatible API. `isolated`
 * runs have no saved Daedalus conversation; `conversation` runs continue one
 * the caller named with X-Daedalus-Conversation-ID.
 */
export interface ApiRunContext {
  protocol: 'openai' | 'anthropic';
  persistence: 'isolated' | 'conversation';
}

export interface AsyncJobRequest {
  jobId: string;
  natBaseUrl: string;
  natSessionId?: string;
  timezone?: string;
  executionMode: 'stream' | 'document_ingest';
  documentIngest?: DocumentIngestJobRequest;
  messages: any[];
  additionalProps?: ChatAdditionalProps | null;
  userId: string;
  conversationId?: string;
  conversationName?: string;
  turnId?: string;
  assistantMessageId?: string;
  /** Backend presentation mode; API runs request only the final answer. */
  responseMode?: 'final_only';
  api?: ApiRunContext;
}

/**
 * Model token usage the backend measured for a whole run, summed across its
 * model calls. A null total means at least one call did not report that
 * field; the `reported*` sums cover only the calls that did.
 */
export interface RunUsage {
  modelCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reportedInputTokens: number;
  reportedOutputTokens: number;
  reportedCachedTokens: number;
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
  generationDurationMs?: number;
  turnId?: string;
  assistantMessageId?: string;
  /** Measured run usage, when the backend reported it before completion. */
  usage?: RunUsage;
}

export interface BackgroundExecutionControl {
  signal?: AbortSignal;
  beforeBackendRequest?: () => Promise<void>;
}

export interface StreamFailureSnapshot {
  response: string;
  pendingSteps: any[];
  persistedStepCount: number;
}

/**
 * An error whose message was written for users. Saved chat errors and job
 * statuses keep only these messages; anything else (Redis, network or
 * provider diagnostics) is logged server-side and saved as a fixed message.
 */
export class PublicJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicJobError';
  }
}

/**
 * The terminal error recorded for a job the user stopped. Finalization saves
 * such a turn as a stopped answer (`metadata.stopped`), not as an error the
 * user should retry; the job status keeps this text for status readers.
 */
export const USER_CANCELLATION_MESSAGE = 'Job canceled by user';

export class StreamUserCancellationError extends Error {
  snapshot?: StreamFailureSnapshot;

  constructor() {
    super(USER_CANCELLATION_MESSAGE);
    this.name = 'StreamUserCancellationError';
  }
}

export interface StreamQueuePayload {
  messagesForNat: any[];
  verifiedUsername: string;
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
