import type { NextApiRequest, NextApiResponse } from 'next';
import { resolve4 } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { getPublisher, getRedis, sessionKey, jsonGet, jsonSetWithExpiry, jsonDel, setStreamingState, clearStreamingState } from '../session/redis';
import { publishStreamingState, publishConversationUpdate } from '@/utils/sync/publish';
import { v4 as uuidv4 } from 'uuid';
import { Message } from '@/types/chat';
import { Logger } from '@/utils/logger';
import {
  buildBackendBaseUrl,
  buildBackendBaseUrlForMode,
  buildBackendUrlFromBase,
  getBackendPodDiscoveryHost,
} from '@/utils/app/backendApi';
import { withInternalBackendAuth } from '@/utils/server/backendAuth';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout';
import { getSession } from '@/utils/auth/session';
import { getOrSetSessionId } from '../session/_utils';
import { canAccessStoredVTT, getVTT } from '../session/vttStorage';
import {
  PRIOR_ASSISTANT_OMITTED_MESSAGE,
  sanitizeConversationAssistantReplays,
  stripReplayedAssistantPrefix,
} from '@/utils/app/conversationReplay';

const logger = new Logger('AsyncJob');

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '300mb',  // Support large document processing payloads
    },
  },
  maxDuration: 900, // 15 minutes
};

interface AsyncJobRequest {
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

interface DocumentIngestJobRequest {
  documentRefs: any[];
  collectionName: string;
  username: string;
}

interface DocumentIngestProgress {
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

interface AsyncJobStatus {
  jobId: string;
  status: 'pending' | 'streaming' | 'oauth_required' | 'completed' | 'error';
  partialResponse?: string;
  fullResponse?: string;
  intermediateSteps?: any[];
  error?: string;
  authUrl?: string;
  oauthState?: string;
  progress?: number;
  ingestProgress?: DocumentIngestProgress;
  createdAt: number;
  updatedAt: number;
  conversationId?: string;
  finalizedAt?: number;
  turnId?: string;
  assistantMessageId?: string;
}

function clearOAuthStatusFields(): Pick<AsyncJobStatus, 'authUrl' | 'oauthState'> {
  return {
    authUrl: undefined,
    oauthState: undefined,
  };
}

interface NatAsyncJobResponse {
  job_id: string;
  status: 'submitted' | 'running' | 'success' | 'failure' | 'interrupted';
  error: string | null;
  output: { value: string } | string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

// Diagnostics gated by DAEDALUS_DEBUG_REPLAY=1. Captures outbound /v1/chat/completions
// payload and raw inbound stream so we can verify whether prior assistant content reaches
// the model. Cap emissions to avoid disk floods if the env var is left enabled.
const DEBUG_REPLAY_ENABLED = process.env.DAEDALUS_DEBUG_REPLAY === '1';
const DEBUG_REPLAY_MAX_EMISSIONS = 200;
let debugReplayEmissionCount = 0;

function debugReplayHash(content: string): string {
  if (!content) return '';
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function debugReplayLog(label: string, fields: Record<string, any>): void {
  if (!DEBUG_REPLAY_ENABLED) return;
  if (debugReplayEmissionCount >= DEBUG_REPLAY_MAX_EMISSIONS) return;
  debugReplayEmissionCount += 1;
  logger.info(`[replay-debug] ${label}`, fields);
}

const JOB_EXPIRY_SECONDS = 60 * 60; // 1 hour
const NAT_SUBMIT_MAX_RETRIES = Number(process.env.NAT_SUBMIT_MAX_RETRIES || 2);
const NAT_RETRY_DELAY_MS = Number(process.env.NAT_RETRY_DELAY_MS || 3_000);
const NAT_CONNECTIVITY_TIMEOUT_MS = Number(process.env.NAT_CONNECTIVITY_TIMEOUT_MS || 2_000);
const NAT_SUBMIT_TIMEOUT_MS = Number(process.env.NAT_SUBMIT_TIMEOUT_MS || 45_000);
const DOCUMENT_INGEST_TIMEOUT_MS = Number(process.env.DOCUMENT_INGEST_TIMEOUT_MS || 60 * 60 * 1000);
const DIRECT_DOCUMENT_INGEST_STREAM_ENABLED =
  process.env.DAEDALUS_DIRECT_DOCUMENT_INGEST_STREAM === '1';
const NAT_BACKEND_CACHE_TTL_MS = 30_000;
const STREAM_STATUS_FLUSH_INTERVAL_MS = 750;
const STREAM_STEPS_FLUSH_INTERVAL_MS = 750;
const STREAM_JOB_STALE_TIMEOUT_MS = 15 * 60 * 1000;
const FINALIZER_POLL_INTERVAL_MS = 5_000;
const FINALIZER_LOCK_TTL_MS = 30_000;
const STATUS_UPDATE_LOCK_TTL_MS = 3_000;
const FINALIZER_MAX_RUNTIME_MS = 60 * 60 * 1000; // match async expiry window

// Redis key signalling that a job has been finalized (or is finalizing).
// Set by handleGet before calling finalizeSuccess/finalizeError so the
// background stream reader stops publishing events and status updates.
const abortKey = (jobId: string) => sessionKey(['async-job-abort', jobId]);
const finalizerLockKey = (jobId: string) => sessionKey(['async-job-finalizer-lock', jobId]);
const statusLockKey = (jobId: string) => sessionKey(['async-job-status-lock', jobId]);

const backgroundFinalizers = new Set<string>();
let cachedStreamBackend: { baseUrl: string; expiresAt: number } | null = null;

class ApiRouteError extends Error {
  status: number;
  reason: string;

  constructor(status: number, message: string, reason: string) {
    super(message);
    this.name = 'ApiRouteError';
    this.status = status;
    this.reason = reason;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRedisLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  options?: { retries?: number; retryDelayMs?: number },
): Promise<T | null> {
  const client = getRedis();
  const token = uuidv4();
  const retries = options?.retries ?? 0;
  const retryDelayMs = options?.retryDelayMs ?? 50;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const acquired = await client.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired === 'OK') {
      try {
        return await fn();
      } finally {
        try {
          await client.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            key,
            token,
          );
        } catch {
          // best effort unlock; TTL still prevents deadlock
        }
      }
    }

    if (attempt < retries) {
      await sleep(retryDelayMs);
    }
  }

  return null;
}

function mapNatStatus(natStatus: string): AsyncJobStatus['status'] {
  switch (natStatus) {
    case 'submitted':
      return 'pending';
    case 'running':
      return 'streaming';
    case 'success':
      return 'completed';
    case 'failure':
    case 'interrupted':
      return 'error';
    default:
      logger.warn(`Unknown NAT job status: ${natStatus}`);
      return 'pending';
  }
}

function extractNatOutput(output: { value: string } | string | null): string {
  if (!output) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && 'value' in output) return String(output.value);
  return JSON.stringify(output);
}

function isTerminalJobStatus(status: AsyncJobStatus['status']): boolean {
  return status === 'completed' || status === 'error';
}

function isPlausibleUnixMs(value: unknown): value is number {
  return typeof value === 'number' && value > 946684800000;
}

function stringifyContent(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (typeof item?.content === 'string') return item.content;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function buildBoundedMessagesForNat(messages: any[]): any[] {
  if (!Array.isArray(messages)) return messages;

  return messages
    .map((message) => {
      if (message?.role !== 'assistant' && message?.role !== 'agent') {
        return message;
      }

      const content = typeof message.content === 'string'
        ? message.content.trim()
        : message.content;
      if (!content) return null;

      // Preserve turn boundaries without sending prior assistant text. Dropping
      // assistant turns leaves old user turns orphaned, which makes the model
      // answer already-resolved questions before the current follow-up.
      return {
        role: 'assistant',
        content: PRIOR_ASSISTANT_OMITTED_MESSAGE,
      };
    })
    .filter(Boolean);
}

export function buildNatSessionId(
  username: string,
  jobId: string,
  conversationId?: string,
  turnId?: string,
): string {
  const seed = [
    username,
    conversationId || 'no-conversation',
    turnId || 'no-turn',
    jobId,
  ].join(':');
  return `daedalus-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function collectDocumentRefs(attachments: any[]): any[] {
  const refs: any[] = [];
  for (const attachment of attachments) {
    if (attachment?.type !== 'document' || !attachment.documentRef) continue;
    refs.push({
      ...attachment.documentRef,
      filename: attachment.content || attachment.documentRef.filename,
    });
  }
  return refs;
}

export function appendDocumentAttachmentContext(
  message: any,
  verifiedUsername: string,
): any {
  if (!message.attachments || !Array.isArray(message.attachments)) {
    return message;
  }

  const documentRefs = collectDocumentRefs(message.attachments);
  if (documentRefs.length === 0) {
    return message;
  }

  const content = typeof message.content === 'string' ? message.content : '';
  const alreadyHasUsableRefs =
    documentRefs.length === 1
      ? content.includes('documentRef=') ||
        content.includes('documentRef parameter')
      : content.includes('documentRefs=') ||
        content.includes('documentRefs parameter');

  if (alreadyHasUsableRefs) {
    return message;
  }

  const targetCollection =
    typeof message.metadata?.targetCollection === 'string' &&
    message.metadata.targetCollection.trim()
      ? message.metadata.targetCollection.trim()
      : undefined;

  const refArg =
    documentRefs.length === 1
      ? `documentRef=${JSON.stringify(documentRefs[0])}`
      : `documentRefs=${JSON.stringify(documentRefs)}`;
  const collectionArg = targetCollection
    ? `, collection_name="${targetCollection}"`
    : '';
  const noun = documentRefs.length === 1 ? 'document' : 'documents';

  const documentContext =
    `\n\n[User has attached ${documentRefs.length} ${noun}. ` +
    `For ingestion, call user_document_tool with operation="ingest", ` +
    `${refArg}, username="${verifiedUsername}"${collectionArg}.]`;

  return {
    ...message,
    content: `${content}${documentContext}`,
  };
}

function isDocumentIngestionMessage(message: any): boolean {
  const documentRefs = collectDocumentRefs(message.attachments || []);
  if (documentRefs.length === 0) return false;

  const content = typeof message.content === 'string' ? message.content : '';
  const hasTargetCollection =
    typeof message.metadata?.targetCollection === 'string' &&
    message.metadata.targetCollection.trim();

  return Boolean(
    hasTargetCollection ||
      /\b(ingest|index|knowledge base|collection)\b/i.test(content),
  );
}

export function isDocumentIngestionRequest(messages: any[]): boolean {
  return Array.isArray(messages) && messages.some(isDocumentIngestionMessage);
}

export function compactDocumentIngestionMessage(
  message: any,
  _verifiedUsername: string,
): any {
  if (!isDocumentIngestionMessage(message)) {
    return message;
  }

  const documentRefs = collectDocumentRefs(message.attachments || []);
  const targetCollection =
    typeof message.metadata?.targetCollection === 'string' &&
    message.metadata.targetCollection.trim()
      ? message.metadata.targetCollection.trim()
      : undefined;
  const noun = documentRefs.length === 1 ? 'document' : 'documents';
  const targetText = targetCollection
    ? ` into the "${targetCollection}" collection`
    : '';

  return {
    ...message,
    content: `Ingest ${documentRefs.length} uploaded ${noun}${targetText}.`,
  };
}

export function getDocumentIngestJobRequest(
  messages: any[],
  verifiedUsername: string,
): DocumentIngestJobRequest | null {
  if (!Array.isArray(messages)) return null;

  for (const message of messages) {
    if (!isDocumentIngestionMessage(message)) continue;
    const documentRefs = collectDocumentRefs(message.attachments || []);
    if (documentRefs.length === 0) continue;
    const targetCollection =
      typeof message.metadata?.targetCollection === 'string' &&
      message.metadata.targetCollection.trim()
        ? message.metadata.targetCollection.trim()
        : verifiedUsername;

    return {
      documentRefs,
      collectionName: targetCollection,
      username: verifiedUsername,
    };
  }

  return null;
}

function buildDocumentIngestNatMessages(
  documentIngest: DocumentIngestJobRequest,
): any[] {
  const refArg =
    documentIngest.documentRefs.length === 1
      ? `documentRef=${JSON.stringify(documentIngest.documentRefs[0])}`
      : `documentRefs=${JSON.stringify(documentIngest.documentRefs)}`;
  const noun = documentIngest.documentRefs.length === 1 ? 'document' : 'documents';

  return [
    {
      role: 'user',
      content:
        `Process ${documentIngest.documentRefs.length} uploaded ${noun} ` +
        `using user_document_tool with operation="ingest", ${refArg}, ` +
        `username="${documentIngest.username}", and ` +
        `collection_name="${documentIngest.collectionName}".`,
    },
  ];
}

export function extractAsyncStreamContentDelta(parsed: any, accumulatedText: string): string {
  const deltaContent = parsed?.choices?.[0]?.delta?.content;
  if (deltaContent !== null && deltaContent !== undefined) {
    return stringifyContent(deltaContent);
  }

  let content =
    parsed?.choices?.[0]?.message?.content ??
    parsed?.output ??
    parsed?.answer ??
    parsed?.value ??
    parsed?.text ??
    parsed?.content ??
    parsed?.data?.output ??
    parsed?.data?.content ??
    '';

  if (!content && Array.isArray(parsed?.outputs)) {
    content = parsed.outputs.join('\n');
  }

  const text = stringifyContent(content);
  if (!text) return '';

  // Some providers send a full-so-far snapshot instead of a token delta.
  // The UI and job status already accumulate chunks, so only forward the new
  // suffix when the snapshot repeats what we have already seen.
  if (accumulatedText && text.startsWith(accumulatedText)) {
    return text.slice(accumulatedText.length);
  }

  return text;
}

export function buildNatRequestHeaders(
  username: string,
  headers: Record<string, string> = {},
  natSessionId?: string,
): Record<string, string> {
  const {
    Cookie: existingCookie,
    cookie: lowercaseExistingCookie,
    ...restHeaders
  } = headers;
  const sessionId = natSessionId?.trim() || username;
  const natCookie = `nat-session=${encodeURIComponent(sessionId)}`;
  const cookieHeader = existingCookie || lowercaseExistingCookie;

  return withInternalBackendAuth({
    ...restHeaders,
    'x-user-id': username,
    Cookie: cookieHeader ? `${cookieHeader}; ${natCookie}` : natCookie,
  });
}

function extractOAuthRequiredPayload(
  eventName: string | null,
  parsed: any,
): { authUrl: string; oauthState?: string } | null {
  const eventType = parsed?.event_type || parsed?.type || parsed?.event;
  const isOAuthEvent = eventName === 'oauth_required' || eventType === 'oauth_required';
  const authUrl = parsed?.auth_url || parsed?.authUrl || parsed?.authorization_url;
  if (!isOAuthEvent || typeof authUrl !== 'string' || !authUrl) {
    return null;
  }

  const oauthState = parsed?.oauth_state || parsed?.oauthState || parsed?.state;
  return {
    authUrl,
    ...(typeof oauthState === 'string' && oauthState ? { oauthState } : {}),
  };
}

function shuffleItems<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function getNatBaseUrl(jobRequest: AsyncJobRequest): string {
  // Legacy fallback for jobs created before backend pinning was deployed.
  return jobRequest.natBaseUrl || buildBackendBaseUrlForMode();
}

export async function resolveAsyncBackendBaseUrls(): Promise<string[]> {
  const fallbackBaseUrl = buildBackendBaseUrlForMode();
  const isKubernetes =
    process.env.KUBERNETES_SERVICE_HOST || process.env.DEPLOYMENT_MODE === 'kubernetes';

  if (!isKubernetes) {
    return [fallbackBaseUrl];
  }

  try {
    const discoveryHost = getBackendPodDiscoveryHost();
    const resolvedIps = await resolve4(discoveryHost);
    const uniqueIps = Array.from(new Set(resolvedIps));

    if (uniqueIps.length === 0) {
      logger.warn(
        `No backend pod IPs resolved for ${discoveryHost}; falling back to service URL ${fallbackBaseUrl}`,
      );
      return [fallbackBaseUrl];
    }

    return shuffleItems(uniqueIps).map((backendHost) => buildBackendBaseUrl({ backendHost }));
  } catch (error: any) {
    logger.warn(
      `Backend pod discovery failed; falling back to service URL ${fallbackBaseUrl}`,
      error,
    );
    return [fallbackBaseUrl];
  }
}

async function selectStreamBackendBaseUrl(
  jobId: string,
  verifiedUsername: string,
  natSessionId: string,
): Promise<string> {
  const natBaseUrls = await resolveAsyncBackendBaseUrls();
  const now = Date.now();
  const candidates =
    cachedStreamBackend &&
    cachedStreamBackend.expiresAt > now &&
    natBaseUrls.includes(cachedStreamBackend.baseUrl)
      ? [
          cachedStreamBackend.baseUrl,
          ...natBaseUrls.filter((url) => url !== cachedStreamBackend!.baseUrl),
        ]
      : natBaseUrls;

  logger.info(`Job ${jobId}: Resolved async backend candidates`, {
    candidateCount: candidates.length,
    candidates,
    cachedCandidate: cachedStreamBackend?.baseUrl || null,
  });

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= NAT_SUBMIT_MAX_RETRIES; attempt++) {
    for (const natBaseUrl of candidates) {
      const healthUrl = buildBackendUrlFromBase(natBaseUrl, '/docs');
      const streamUrl = buildBackendUrlFromBase(natBaseUrl, '/v1/chat/completions');

      logger.info(`Job ${jobId}: Checking stream backend at ${streamUrl}`, {
        attempt,
        maxAttempts: NAT_SUBMIT_MAX_RETRIES,
        natBaseUrl,
      });

      try {
        const healthResponse = await fetchWithTimeout(
          healthUrl,
          { method: 'HEAD', headers: buildNatRequestHeaders(verifiedUsername, {}, natSessionId) },
          NAT_CONNECTIVITY_TIMEOUT_MS,
        );
        if (!healthResponse.ok) {
          throw new Error(`HTTP ${healthResponse.status}`);
        }
        cachedStreamBackend = {
          baseUrl: natBaseUrl,
          expiresAt: Date.now() + NAT_BACKEND_CACHE_TTL_MS,
        };
        return natBaseUrl;
      } catch (err: any) {
        if (cachedStreamBackend?.baseUrl === natBaseUrl) {
          cachedStreamBackend = null;
        }
        lastError = `connectivity check failed for ${natBaseUrl}: ${err.message || 'Unknown fetch error'}`;
        logger.warn(
          `Job ${jobId}: Stream backend check failed on ${natBaseUrl} (attempt ${attempt}/${NAT_SUBMIT_MAX_RETRIES}): ${lastError}`,
        );
      }
    }

    if (attempt < NAT_SUBMIT_MAX_RETRIES) {
      logger.info(`Job ${jobId}: Retrying in ${NAT_RETRY_DELAY_MS}ms...`);
      await sleep(NAT_RETRY_DELAY_MS);
    }
  }

  throw new ApiRouteError(
    502,
    `Backend unavailable after ${NAT_SUBMIT_MAX_RETRIES} attempts: ${lastError}`,
    'backend_unavailable',
  );
}

async function submitNatAsyncJob(
  jobId: string,
  natBaseUrl: string,
  messagesForNat: any[],
  verifiedUsername: string,
  natSessionId: string,
): Promise<void> {
  const submitUrl = buildBackendUrlFromBase(natBaseUrl, '/v1/workflow/async');
  const payload = {
    messages: messagesForNat,
    job_id: jobId,
    sync_timeout: 0,
    expiry_seconds: JOB_EXPIRY_SECONDS,
  };

  const response = await fetchWithTimeout(
    submitUrl,
    {
      method: 'POST',
      headers: buildNatRequestHeaders(
        verifiedUsername,
        { 'Content-Type': 'application/json' },
        natSessionId,
      ),
      body: JSON.stringify(payload),
    },
    NAT_SUBMIT_TIMEOUT_MS,
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new ApiRouteError(
      response.status >= 500 ? 502 : response.status,
      `Backend async job submission failed (${response.status})${
        errorText ? `: ${errorText}` : ''
      }`,
      'backend_submit_failed',
    );
  }
}

export async function fetchNatJobStatus(
  jobId: string,
  jobRequest: AsyncJobRequest,
): Promise<NatAsyncJobResponse | null> {
  const natStatusUrl = buildBackendUrlFromBase(
    getNatBaseUrl(jobRequest),
    `/v1/workflow/async/job/${encodeURIComponent(jobId)}`,
  );
  const natResponse = await fetchWithTimeout(
    natStatusUrl,
    { headers: buildNatRequestHeaders(jobRequest.userId, {}, jobRequest.natSessionId) },
    30_000,
  );

  if (!natResponse.ok) {
    if (natResponse.status === 404) {
      if (!jobRequest.natBaseUrl) {
        logger.warn(
          `Job ${jobId}: Received 404 from legacy shared backend route; leaving job pending for retry`,
        );
        return null;
      }
      return {
        job_id: jobId,
        status: 'failure',
        error: 'Job not found on backend (may have expired)',
        output: null,
        created_at: '',
        updated_at: '',
        expires_at: '',
      };
    }
    throw new Error(`NAT returned ${natResponse.status}`);
  }

  return natResponse.json();
}

async function finalizeFromNatStatus(
  jobId: string,
  jobRequest: AsyncJobRequest,
  natStatus: NatAsyncJobResponse,
): Promise<AsyncJobStatus | null> {
  const statusKey = sessionKey(['async-job-status', jobId]);
  const mapped = mapNatStatus(natStatus.status);

  const finalized = await withRedisLock(
    finalizerLockKey(jobId),
    FINALIZER_LOCK_TTL_MS,
    async () => {
      const current = await jsonGet(statusKey) as AsyncJobStatus | null;
      if (!current) return null;
      if (current.finalizedAt || isTerminalJobStatus(current.status)) {
        return current;
      }

      await jsonSetWithExpiry(abortKey(jobId), true, JOB_EXPIRY_SECONDS).catch(() => {});

      if (mapped === 'error') {
        await finalizeError(jobId, jobRequest, natStatus.error || 'Backend job failed');
      } else if (mapped === 'completed') {
        const rawOutput = extractNatOutput(natStatus.output);
        await finalizeSuccess(jobId, jobRequest, rawOutput);
      }

      return await jsonGet(statusKey) as AsyncJobStatus | null;
    },
    { retries: 3, retryDelayMs: 50 },
  );

  if (finalized) return finalized;
  return await jsonGet(statusKey) as AsyncJobStatus | null;
}

function launchBackgroundFinalizer(jobId: string, jobRequest: AsyncJobRequest): void {
  if (backgroundFinalizers.has(jobId)) return;
  backgroundFinalizers.add(jobId);
  startBackgroundFinalizer(jobId, jobRequest)
    .catch((err) => {
      logger.error(`Job ${jobId}: Background finalizer failed`, err);
    })
    .finally(() => {
      backgroundFinalizers.delete(jobId);
    });
}

function formatIngestPartialResponse(
  collectionName: string,
  ingestProgress: DocumentIngestProgress,
): string {
  const { completed, total, currentDoc, currentIndex, message, phase } = ingestProgress;
  if (message) {
    return `${message} (${completed}/${total} into "${collectionName}").`;
  }
  if (completed >= total && total > 0) {
    return `Finalizing ingestion into "${collectionName}".`;
  }
  if (phase === 'fetching') {
    return `Fetching ${currentDoc || 'document'} for ingestion into "${collectionName}".`;
  }
  if (phase === 'indexing') {
    return `Writing ${currentDoc || 'document'} chunks to "${collectionName}".`;
  }
  if (currentDoc) {
    const indexText = currentIndex ? `document ${currentIndex} of ${total}` : `${completed} of ${total}`;
    return `Ingesting ${indexText} into "${collectionName}" (${currentDoc}).`;
  }
  return `Ingesting ${total} document${total === 1 ? '' : 's'} into "${collectionName}".`;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function streamDocumentIngestJob(
  jobId: string,
  jobRequest: AsyncJobRequest,
  verifiedUsername: string,
  onProgress: (progress: DocumentIngestProgress) => Promise<void>,
): Promise<string> {
  if (!jobRequest.documentIngest) {
    throw new ApiRouteError(
      500,
      'Document ingest job is missing document references.',
      'document_ingest_missing_payload',
    );
  }

  const ingestUrl = buildBackendUrlFromBase(
    getNatBaseUrl(jobRequest),
    '/v1/documents/ingest/stream',
  );
  const payload = {
    documentRefs: jobRequest.documentIngest.documentRefs,
    username: jobRequest.documentIngest.username,
    collection_name: jobRequest.documentIngest.collectionName,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOCUMENT_INGEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(ingestUrl, {
      method: 'POST',
      headers: buildNatRequestHeaders(
        verifiedUsername,
        { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        jobRequest.natSessionId,
      ),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      throw new Error(`Document ingest timed out after ${DOCUMENT_INGEST_TIMEOUT_MS}ms`);
    }
    throw err;
  }

  if (!response.ok) {
    clearTimeout(timeoutId);
    const errBody = await response.text().catch(() => '');
    throw new Error(`Document ingest failed (${response.status}): ${errBody || response.statusText}`);
  }

  if (!response.body) {
    clearTimeout(timeoutId);
    throw new Error('Document ingest stream returned no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalOutput: string | null = null;
  let errorDetail: string | null = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIdx: number;
      while ((separatorIdx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, separatorIdx);
        buffer = buffer.slice(separatorIdx + 2);
        if (!rawEvent.trim()) continue;

        let event = 'message';
        const dataLines: string[] = [];
        for (const line of rawEvent.split(/\r?\n/)) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
          }
        }
        const dataStr = dataLines.join('\n');
        if (!dataStr) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (event === 'progress') {
          await onProgress({
            completed: Number(parsed.completed) || 0,
            total: Number(parsed.total) || 0,
            currentDoc: typeof parsed.current === 'string' ? parsed.current : undefined,
            currentIndex: optionalNumber(parsed.currentIndex),
            percent: Number(parsed.percent) || 0,
            phase: typeof parsed.phase === 'string' ? parsed.phase : undefined,
            message: typeof parsed.message === 'string' ? parsed.message : undefined,
            chunks: optionalNumber(parsed.chunks),
            pages: optionalNumber(parsed.pages),
            failures: optionalNumber(parsed.failures),
            attempt: optionalNumber(parsed.attempt),
          });
        } else if (event === 'complete') {
          finalOutput = typeof parsed.output === 'string' ? parsed.output : '';
        } else if (event === 'error') {
          errorDetail = typeof parsed.detail === 'string' ? parsed.detail : 'Unknown error';
        }
      }
    }
  } finally {
    clearTimeout(timeoutId);
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  if (errorDetail) {
    throw new Error(`Document ingest failed: ${errorDetail}`);
  }
  return finalOutput || 'Document ingestion completed.';
}

async function startBackgroundDocumentIngest(
  jobId: string,
  jobRequest: AsyncJobRequest,
  verifiedUsername: string,
): Promise<void> {
  const documentCount = jobRequest.documentIngest?.documentRefs.length || 0;
  const collectionName = jobRequest.documentIngest?.collectionName || verifiedUsername;

  const initialIngestProgress: DocumentIngestProgress = {
    completed: 0,
    total: documentCount,
    percent: 0,
    phase: 'queued',
    message: `Queued ${documentCount} document${documentCount === 1 ? '' : 's'} for ingestion`,
  };

  await updateJobStatus(jobId, {
    status: 'streaming',
    partialResponse: formatIngestPartialResponse(collectionName, initialIngestProgress),
    progress: 0,
    ingestProgress: initialIngestProgress,
    ...clearOAuthStatusFields(),
    updatedAt: Date.now(),
  });

  try {
    const output = await streamDocumentIngestJob(
      jobId,
      jobRequest,
      verifiedUsername,
      async (progress) => {
        await updateJobStatus(jobId, {
          status: 'streaming',
          progress: progress.percent,
          ingestProgress: progress,
          partialResponse: formatIngestPartialResponse(collectionName, progress),
          updatedAt: Date.now(),
        });
      },
    );
    await finalizeSuccess(jobId, jobRequest, output);
  } catch (error: any) {
    logger.error(`Job ${jobId}: Direct document ingest failed`, error);
    await finalizeError(
      jobId,
      jobRequest,
      error?.message || 'Document ingestion failed.',
    );
  }
}

async function sanitizeJobStatusForReturn(
  jobId: string,
  status: AsyncJobStatus,
  jobRequest: AsyncJobRequest,
): Promise<AsyncJobStatus> {
  const updates: Partial<AsyncJobStatus> = {};

  if (status.status !== 'oauth_required' && (status.authUrl || status.oauthState)) {
    Object.assign(updates, clearOAuthStatusFields());
  }

  if (typeof status.fullResponse === 'string' && status.fullResponse) {
    const fullResponse = stripReplayedAssistantPrefix(
      status.fullResponse,
      jobRequest.messages || [],
    );
    if (fullResponse !== status.fullResponse) {
      updates.fullResponse = fullResponse;
    }
  }

  if (typeof status.partialResponse === 'string' && status.partialResponse) {
    const partialResponse = stripReplayedAssistantPrefix(
      status.partialResponse,
      jobRequest.messages || [],
    );
    if (partialResponse !== status.partialResponse) {
      updates.partialResponse = partialResponse;
    }
  }

  if (Object.keys(updates).length === 0) {
    return status;
  }

  const sanitized = {
    ...status,
    ...updates,
    updatedAt: Date.now(),
  };
  await updateJobStatus(jobId, {
    ...updates,
    updatedAt: sanitized.updatedAt,
  }).catch((error) => {
    logger.warn(`Job ${jobId}: Failed to persist sanitized response`, error);
  });
  return sanitized;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    return handlePost(req, res);
  } else if (req.method === 'GET') {
    return handleGet(req, res);
  } else if (req.method === 'DELETE') {
    return handleDelete(req, res);
  }

  res.setHeader('Allow', ['POST', 'GET', 'DELETE']);
  return res.status(405).json({ error: 'Method not allowed' });
}

// ── Intermediate step helpers ────────────────────────────────────────

/**
 * Parse a NAT v1.6.0+ `intermediate_data:` JSON line into the
 * IntermediateStep shape the frontend expects.
 */
function parseIntermediateDataLine(json: string): any | null {
  try {
    const parsed = JSON.parse(json);
    const isComplete = parsed.name?.includes('Complete:');
    const isWorkflow = parsed.name?.includes('<workflow>');

    const cleanName = parsed.name
      ?.replace(/^Function (Start|Complete): /, '')
      .replace(/<|>/g, '') || 'System Step';

    let eventType: string;
    if (isWorkflow) {
      eventType = isComplete ? 'WORKFLOW_END' : 'WORKFLOW_START';
    } else {
      eventType = isComplete ? 'TOOL_END' : 'TOOL_START';
    }

    return {
      parent_id: parsed.parent_id || 'root',
      function_ancestry: {
        node_id: parsed.id || `step-${Date.now()}`,
        parent_id: parsed.parent_id || null,
        function_name: cleanName,
        depth: 0,
      },
      payload: {
        event_type: eventType,
        event_timestamp: Date.now() / 1000,
        name: cleanName,
        metadata: { original_payload: parsed },
        data: { output: parsed.payload || '' },
        UUID: parsed.id || `${Date.now()}-${Math.random()}`,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Open a streaming connection to the backend's interactive OpenAI-compatible
 * endpoint to capture intermediate steps, OAuth prompts, and content tokens.
 *
 * Runs fire-and-forget after the POST handler returns the jobId.  The
 * accumulated steps are stored in Redis so that handleGet() and
 * finalizeSuccess() can include them.
 */
async function startBackgroundStreamReader(
  jobId: string,
  jobRequest: AsyncJobRequest,
  messagesForNat: any[],
  verifiedUsername: string,
): Promise<void> {
  const streamUrl = buildBackendUrlFromBase(getNatBaseUrl(jobRequest), '/v1/chat/completions');
  const payload = {
    messages: messagesForNat,
    model: 'string',
    temperature: 0,
    max_tokens: 0,
    top_p: 0,
    use_knowledge_base: true,
    top_k: 0,
    collection_name: 'string',
    stop: true,
    stream: true,
    user_id: verifiedUsername,
    additional_props: {
      ...(jobRequest.additionalProps || {}),
      enableIntermediateSteps: true,
    },
    stream_options: { include_usage: true },
  };

  const userId = jobRequest.userId;
  const conversationId = jobRequest.conversationId;
  const stepsKey = sessionKey(['async-job-steps', jobId]);
  const accumulatedSteps: any[] = [];
  let partialResponse = '';
  let lastToolOutput = '';
  let streamDone = false;

  try {
    logger.info(`Job ${jobId}: Starting background stream reader at ${streamUrl}`);

    if (DEBUG_REPLAY_ENABLED) {
      const roleHistogram: Record<string, number> = {};
      const messagePreviews = (messagesForNat || []).map((m: any) => {
        const role = typeof m?.role === 'string' ? m.role : 'unknown';
        roleHistogram[role] = (roleHistogram[role] || 0) + 1;
        const content = typeof m?.content === 'string' ? m.content : '';
        return {
          role,
          contentLength: content.length,
          contentPreview: content.slice(0, 200),
          contentSha256: debugReplayHash(content),
        };
      });
      debugReplayLog('outbound', {
        jobId,
        conversationId,
        userId,
        streamUrl,
        messageCount: messagesForNat?.length ?? 0,
        roleHistogram,
        containsAssistantRole: !!roleHistogram.assistant,
        messages: messagePreviews,
      });
    }

    const abortController = new AbortController();
    const response = await fetch(streamUrl, {
      method: 'POST',
      headers: buildNatRequestHeaders(
        verifiedUsername,
        { 'Content-Type': 'application/json' },
        jobRequest.natSessionId,
      ),
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => '');
      logger.error(`Job ${jobId}: Stream reader got ${response.status}, aborting`);
      await finalizeError(
        jobId,
        jobRequest,
        `Backend stream returned ${response.status}${errorText ? ` - ${errorText}` : ''}`,
      );
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentSseEvent: string | null = null;
    const publisher = getPublisher();
    const tokenChannel = conversationId
      ? `user:${userId}:chat:${conversationId}:tokens`
      : null;

    // Rate-limited abort check: at most once per second to avoid Redis overhead.
    // handleGet sets abortKey before calling finalizeSuccess so the parallel
    // stream reader stops publishing events and updating job status.
    let lastAbortCheckMs = 0;
    let lastStatusFlushMs = 0;
    let lastStepsFlushMs = 0;
    let debugDeltaCounter = 0;

    const flushSteps = async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastStepsFlushMs < STREAM_STEPS_FLUSH_INTERVAL_MS) return;
      lastStepsFlushMs = now;
      await jsonSetWithExpiry(stepsKey, accumulatedSteps, JOB_EXPIRY_SECONDS);
    };

    const flushStreamingStatus = async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastStatusFlushMs < STREAM_STATUS_FLUSH_INTERVAL_MS) return;
      lastStatusFlushMs = now;
      await updateJobStatus(jobId, {
        status: 'streaming',
        partialResponse,
        intermediateSteps: accumulatedSteps,
        ...clearOAuthStatusFields(),
        updatedAt: now,
      });
    };

    while (true) {
      // Check for abort signal from handleGet (job already finalized)
      const nowMs = Date.now();
      if (nowMs - lastAbortCheckMs > 1000) {
        lastAbortCheckMs = nowMs;
        const shouldAbort = await jsonGet(abortKey(jobId));
        if (shouldAbort) {
          logger.info(`Job ${jobId}: Stream reader received abort signal — job finalized, stopping`);
          abortController.abort();
          return;
        }
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line === '') {
          currentSseEvent = null;
          continue;
        }

        if (line.startsWith('event: ')) {
          currentSseEvent = line.slice('event: '.length).trim();
          continue;
        }

        // ── intermediate_data: lines → parse step, store, publish ──
        if (line.startsWith('intermediate_data: ')) {
          const step = parseIntermediateDataLine(
            line.slice('intermediate_data: '.length),
          );
          if (step) {
            // Defense-in-depth: sanitize completion-event outputs against any
            // prior assistant content. TOOL_END is intentionally excluded —
            // tool outputs (search snippets, retrieved chunks) may legitimately
            // resemble prior assistant text and we don't want to corrupt them
            // here. TOOL_END sanitization runs only when lastToolOutput is
            // promoted to partialResponse below.
            const eventType = step?.payload?.event_type;
            if (
              (eventType === 'LLM_END' ||
                eventType === 'WORKFLOW_END' ||
                eventType === 'TASK_END') &&
              typeof step?.payload?.data?.output === 'string'
            ) {
              const original = step.payload.data.output as string;
              const sanitized = stripReplayedAssistantPrefix(
                original,
                jobRequest.messages || [],
              );
              if (sanitized !== original) {
                step.payload.data.output = sanitized;
              }
            }

            accumulatedSteps.push(step);
            // Persist incrementally so handleGet() can return live steps
            await flushSteps();
            await flushStreamingStatus(true);

            if (tokenChannel) {
              publisher.publish(tokenChannel, JSON.stringify({
                type: 'chat_intermediate_step',
                conversationId,
                jobId,
                turnId: jobRequest.turnId,
                assistantMessageId: jobRequest.assistantMessageId,
                step,
              })).catch(() => {});
            }

            // Extract function output for partial response tracking
            const raw = step.payload?.data?.output;
            if (
              step.payload?.event_type === 'TOOL_END' &&
              typeof raw === 'string'
            ) {
              const marker = '**Function Output:**\n```';
              const mIdx = raw.lastIndexOf(marker);
              if (mIdx !== -1) {
                const contentStart = raw.indexOf('\n', mIdx + marker.length);
                if (contentStart !== -1) {
                  let output = raw.slice(contentStart + 1);
                  const lastFence = output.lastIndexOf('\n```');
                  if (lastFence !== -1) output = output.slice(0, lastFence);
                  if (output.trim() && output.trim() !== '[]') {
                    lastToolOutput = output.trim();
                  }
                }
              }
            }
          }
        }

        // ── data: lines → extract content tokens ──
        if (line.startsWith('data: ')) {
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            streamDone = true;
            break;
          }
          try {
            const parsed = JSON.parse(data);
            const oauthPayload = extractOAuthRequiredPayload(currentSseEvent, parsed);
            if (oauthPayload) {
              await updateJobStatus(jobId, {
                status: 'oauth_required',
                authUrl: oauthPayload.authUrl,
                oauthState: oauthPayload.oauthState,
                partialResponse,
                intermediateSteps: accumulatedSteps,
                progress: 0,
                updatedAt: Date.now(),
              });
              continue;
            }
            if (parsed.error) continue;
            const content = extractAsyncStreamContentDelta(parsed, partialResponse);
            if (content && typeof content === 'string') {
              partialResponse += content;
              if (DEBUG_REPLAY_ENABLED) {
                debugDeltaCounter += 1;
                if (debugDeltaCounter % 10 === 0 || content.length > 100) {
                  debugReplayLog('inbound-delta', {
                    jobId,
                    deltaIndex: debugDeltaCounter,
                    deltaLength: content.length,
                    deltaPreview: content.slice(0, 120),
                    partialResponseLength: partialResponse.length,
                  });
                }
              }
              // Publish content token for real-time streaming in PWA
              if (tokenChannel) {
                publisher.publish(tokenChannel, JSON.stringify({
                  type: 'chat_token',
                  conversationId,
                  jobId,
                  turnId: jobRequest.turnId,
                  assistantMessageId: jobRequest.assistantMessageId,
                  content,
                })).catch(() => {});
              }
              await flushStreamingStatus();
            }
          } catch {
            // Non-JSON data line — skip
          }
        }
      }

      if (streamDone) break;
    }

    // If stream produced content but NAT async hasn't finished yet, use
    // lastToolOutput as recovery. Sanitize at the moment of promotion so the
    // user-facing answer is protected even if the raw tool output happens to
    // contain prior assistant text. Raw step data in accumulatedSteps is left
    // untouched on purpose so the steps panel still shows the true tool data.
    if (!partialResponse.trim() && lastToolOutput) {
      partialResponse = stripReplayedAssistantPrefix(
        lastToolOutput,
        jobRequest.messages || [],
      );
    }

    // Final persist of all accumulated steps
    await flushSteps(true);
    const currentStatus = await jsonGet(sessionKey(['async-job-status', jobId])) as AsyncJobStatus | null;
    if (currentStatus?.status === 'oauth_required' && !partialResponse.trim()) {
      await finalizeError(
        jobId,
        jobRequest,
        'OAuth authorization did not complete before the backend stream closed',
      );
      return;
    }

    if (DEBUG_REPLAY_ENABLED) {
      debugReplayLog('inbound-final', {
        jobId,
        finalLength: partialResponse.length,
        finalSha: debugReplayHash(partialResponse),
        finalHead: partialResponse.slice(0, 200),
        finalTail: partialResponse.slice(-200),
        stepsCount: accumulatedSteps.length,
      });
    }

    await finalizeSuccess(jobId, jobRequest, partialResponse);

    logger.info(`Job ${jobId}: Stream reader finished`, {
      steps: accumulatedSteps.length,
      partialResponseLength: partialResponse.length,
    });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      // Clean abort — job was finalized by handleGet, not a real error.
      logger.info(`Job ${jobId}: Stream reader aborted cleanly (job finalized)`);
    } else {
      logger.error(`Job ${jobId}: Stream reader error: ${err.message}`);
      await finalizeError(
        jobId,
        jobRequest,
        err.message || 'Backend stream reader failed',
      ).catch((finalizeErr) => {
        logger.error(`Job ${jobId}: Failed to finalize stream reader error`, finalizeErr);
      });
    }
    // Persist whatever we have so far (steps may still be useful)
    if (accumulatedSteps.length > 0) {
      await jsonSetWithExpiry(stepsKey, accumulatedSteps, JOB_EXPIRY_SECONDS).catch(() => {});
    }
  }
}

async function startBackgroundFinalizer(
  jobId: string,
  jobRequest: AsyncJobRequest,
): Promise<void> {
  const startedAt = Date.now();
  const statusKey = sessionKey(['async-job-status', jobId]);
  const stepsKey = sessionKey(['async-job-steps', jobId]);

  while (Date.now() - startedAt < FINALIZER_MAX_RUNTIME_MS) {
    const status = await jsonGet(statusKey) as AsyncJobStatus | null;
    if (!status) return;
    if (status.finalizedAt || isTerminalJobStatus(status.status)) return;

    const shouldAbort = await jsonGet(abortKey(jobId));
    if (shouldAbort && status.finalizedAt) return;

    try {
      const natStatus = await fetchNatJobStatus(jobId, jobRequest);
      if (!natStatus) {
        await sleep(FINALIZER_POLL_INTERVAL_MS);
        continue;
      }

      const mapped = mapNatStatus(natStatus.status);
      if (mapped === 'pending' || mapped === 'streaming') {
        const liveSteps = await jsonGet(stepsKey) as any[] | null;
        await updateJobStatus(jobId, {
          status: mapped,
          progress: mapped === 'streaming' ? 50 : 0,
          ...clearOAuthStatusFields(),
          ...(liveSteps?.length ? { intermediateSteps: liveSteps } : {}),
          updatedAt: Date.now(),
        });
      } else {
        await finalizeFromNatStatus(jobId, jobRequest, natStatus);
        return;
      }
    } catch (err) {
      logger.warn(`Job ${jobId}: Background finalizer poll failed`, err);
    }

    await sleep(FINALIZER_POLL_INTERVAL_MS);
  }

  const timeoutStatus: NatAsyncJobResponse = {
    job_id: jobId,
    status: 'failure',
    error: `Async job did not finalize within ${FINALIZER_MAX_RUNTIME_MS / 1000}s`,
    output: null,
    created_at: '',
    updated_at: '',
    expires_at: '',
  };
  await finalizeFromNatStatus(jobId, jobRequest, timeoutStatus).catch((err) => {
    logger.error(`Job ${jobId}: Failed timeout finalization`, err);
  });
}

// ── POST: Submit a new async job to NAT ──────────────────────────────

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  try {
    const {
      messages,
      additionalProps,
      conversationId,
      conversationName,
      turnId,
      assistantMessageId,
    } = req.body;

    // SECURITY: Derive user identity from the server-side session,
    // not from client-sent identity fields which can be spoofed.
    const session = await getSession(req, res);
    if (!session?.username) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const verifiedUsername = session.username;
    const currentSessionId = getOrSetSessionId(req, res);

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages' });
    }

    // Overwrite client-sent identity fields with verified values
    if (additionalProps) {
      additionalProps.username = verifiedUsername;
      if (additionalProps.userContext) {
        additionalProps.userContext.username = verifiedUsername;
        additionalProps.userContext.id = session?.userId || null;
        additionalProps.userContext.name = session?.name || null;
      }
    }

    const jobId = uuidv4();
    const natSessionId = buildNatSessionId(
      verifiedUsername,
      jobId,
      typeof conversationId === 'string' ? conversationId : undefined,
      typeof turnId === 'string' ? turnId : undefined,
    );

    // Process messages: add attachment references/content for agent context
    const processedMessages = await Promise.all((messages || []).map(async (message: any) => {
      let cleanedMessage = { ...message };

      if (cleanedMessage.attachments && Array.isArray(cleanedMessage.attachments)) {
        // Image references
        const imageAttachments = cleanedMessage.attachments.filter((att: any) => att.type === 'image');
        if (imageAttachments.length > 0) {
          // Skip if cleanMessagesForLLM already injected references
          const alreadyHasImageRefs = cleanedMessage.content?.includes('[IMAGE_REFERENCE_');
          if (!alreadyHasImageRefs) {
            const allImageRefs: any[] = [];
            imageAttachments.forEach((att: any) => {
              if (att.imageRef) {
                allImageRefs.push(att.imageRef);
              } else if (att.imageRefs && Array.isArray(att.imageRefs)) {
                allImageRefs.push(...att.imageRefs);
              }
            });

            if (allImageRefs.length > 0) {
              let imageRefContext = '\n\n[User has attached ';
              if (allImageRefs.length === 1) {
                imageRefContext += `1 image. To use this image with tools, pass imageRef=${JSON.stringify(allImageRefs[0])}]`;
              } else {
                imageRefContext += `${allImageRefs.length} images. To use these images with tools, pass imageRef=${JSON.stringify(allImageRefs)}]`;
              }
              cleanedMessage.content = (cleanedMessage.content || '') + imageRefContext;
            }
          }
        }

        // Video references
        const videoAttachments = cleanedMessage.attachments.filter((att: any) => att.type === 'video');
        if (videoAttachments.length > 0) {
          const alreadyHasVideoRefs = cleanedMessage.content?.includes('[VIDEO_REFERENCE_');
          if (!alreadyHasVideoRefs) {
            const allVideoRefs: any[] = [];
            videoAttachments.forEach((att: any) => {
              if (att.videoRef) {
                allVideoRefs.push(att.videoRef);
              } else if (att.videoRefs && Array.isArray(att.videoRefs)) {
                allVideoRefs.push(...att.videoRefs);
              }
            });

            if (allVideoRefs.length > 0) {
              let videoRefContext = '\n\n[User has attached ';
              if (allVideoRefs.length === 1) {
                videoRefContext += `1 video. To use this video with tools, pass videoRef=${JSON.stringify(allVideoRefs[0])}]`;
              } else {
                videoRefContext += `${allVideoRefs.length} videos. To use these videos with tools, pass videoRef=${JSON.stringify(allVideoRefs)}]`;
              }
              cleanedMessage.content = (cleanedMessage.content || '') + videoRefContext;
            }
          }
        }

        // VTT/transcript content — retrieve from Redis and inject into message
        const vttAttachments = cleanedMessage.attachments.filter((att: any) => att.type === 'transcript');
        if (vttAttachments.length > 0) {
          const alreadyHasVttContent = cleanedMessage.content?.includes('<transcript filename=');
          if (!alreadyHasVttContent) {
            for (const att of vttAttachments) {
              if (att.vttRef?.vttId && att.vttRef?.sessionId) {
                try {
                  const storedVtt = await getVTT(att.vttRef.sessionId, att.vttRef.vttId);
                  if (!storedVtt) {
                    throw new ApiRouteError(
                      404,
                      'Transcript attachment not found. Please upload it again.',
                      'attachment_not_found',
                    );
                  }
                  if (!canAccessStoredVTT(storedVtt, currentSessionId, verifiedUsername)) {
                    throw new ApiRouteError(
                      403,
                      'You do not have access to one of the transcript attachments.',
                      'attachment_forbidden',
                    );
                  }
                  if (storedVtt?.data) {
                    const filename = att.vttRef.filename || storedVtt.filename || 'transcript';
                    let vttContext = `\n\n[User has attached a VTT/SRT transcript file "${filename}". `;
                    vttContext += `Use the vtt_interpreter_tool to process this transcript. `;
                    vttContext += `Pass the transcript content below as the transcript_text parameter. `;
                    vttContext += `If the user's message contains specific instructions (e.g. "list action items", "what did X say about Y"), pass those as the user_instructions parameter.]\n\n`;
                    vttContext += `<transcript filename="${filename}">\n${storedVtt.data}\n</transcript>`;
                    cleanedMessage.content = (cleanedMessage.content || '') + vttContext;
                    logger.info(`Job ${jobId}: Added VTT content to message`, {
                      filename,
                      vttContentLength: storedVtt.data.length,
                      totalContentLength: cleanedMessage.content.length,
                    });
                  } else {
                    throw new ApiRouteError(
                      400,
                      'Transcript attachment is empty. Please upload it again.',
                      'attachment_empty',
                    );
                  }
                } catch (error) {
                  if (error instanceof ApiRouteError) throw error;
                  logger.error(`Job ${jobId}: Error retrieving VTT from Redis`, { vttRef: att.vttRef, error });
                  throw new ApiRouteError(
                    500,
                    'Failed to read transcript attachment. Please try again.',
                    'attachment_read_failed',
                  );
                }
              }
            }
          }
        }
      }

      cleanedMessage = compactDocumentIngestionMessage(
        appendDocumentAttachmentContext(cleanedMessage, verifiedUsername),
        verifiedUsername,
      );

      return cleanedMessage;
    }));

    const documentIngest = getDocumentIngestJobRequest(
      processedMessages,
      verifiedUsername,
    );
    const useDirectDocumentIngest = Boolean(
      documentIngest && DIRECT_DOCUMENT_INGEST_STREAM_ENABLED,
    );

    // Strip system messages -- the backend's NAT agent owns the system prompt.
    // Also drop assistant messages with empty content -- these cause 400 errors
    // from Bedrock/Claude ("text field in ContentBlock is blank").
    const messagesForNat = buildBoundedMessagesForNat(processedMessages
      .filter((m: any) => m.role !== 'system')
      .filter((m: any) => {
        if (m.role === 'assistant') {
          const c = typeof m.content === 'string' ? m.content.trim() : m.content;
          return Boolean(c);
        }
        return true;
      }));

    // Inject authenticated identity AFTER stripping client-sent system messages.
    // Uses 'user' role to avoid conflicts with NAT's own system prompt and LLMs
    // that reject multiple system messages (e.g. Qwen, certain NIM endpoints).
    // The [IDENTITY] tag lets the agent distinguish this from real user input.
    const messagesWithIdentity = [
      {
        role: 'user',
        content:
          `[IDENTITY] The authenticated user for this session is: ${verifiedUsername}. ` +
          `Use user_id="${verifiedUsername}" for ALL memory operations ` +
          '(get_memory, add_memory, delete_memory), uploaded media tool calls ' +
          'that require user_id, and per-user Google Workspace MCP access.',
      },
      ...messagesForNat,
    ];
    const durableMessagesForNat =
      documentIngest && !useDirectDocumentIngest
        ? [
            messagesWithIdentity[0],
            ...buildDocumentIngestNatMessages(documentIngest),
          ]
        : messagesWithIdentity;

    const selectedNatBaseUrl = await selectStreamBackendBaseUrl(
      jobId,
      verifiedUsername,
      natSessionId,
    );

    logger.info(`Job ${jobId}: Selected async backend`, {
      natBaseUrl: selectedNatBaseUrl,
      executionMode: useDirectDocumentIngest ? 'document_ingest' : 'nat_async',
    });

    // Store job metadata in Redis for the GET handler
    const jobRequest: AsyncJobRequest = {
      jobId,
      executionMode: useDirectDocumentIngest ? 'document_ingest' : 'nat_async',
      natBaseUrl: selectedNatBaseUrl || buildBackendBaseUrlForMode(),
      natSessionId,
      natMessages: useDirectDocumentIngest ? [] : durableMessagesForNat,
      ...(documentIngest ? { documentIngest } : {}),
      messages, // original messages for conversation saving later
      additionalProps,
      userId: verifiedUsername,
      conversationId,
      conversationName,
      ...(typeof turnId === 'string' && turnId ? { turnId } : {}),
      ...(typeof assistantMessageId === 'string' && assistantMessageId ? { assistantMessageId } : {}),
    };

    if (!useDirectDocumentIngest) {
      await submitNatAsyncJob(
        jobId,
        jobRequest.natBaseUrl,
        durableMessagesForNat,
        verifiedUsername,
        natSessionId,
      );
    }

    await jsonSetWithExpiry(sessionKey(['async-job-request', jobId]), jobRequest, JOB_EXPIRY_SECONDS);

    // Initialize job status
    const jobStatus: AsyncJobStatus = {
      jobId,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      conversationId,
      ...(typeof turnId === 'string' && turnId ? { turnId } : {}),
      ...(typeof assistantMessageId === 'string' && assistantMessageId ? { assistantMessageId } : {}),
    };
    await jsonSetWithExpiry(sessionKey(['async-job-status', jobId]), jobStatus, JOB_EXPIRY_SECONDS);

    if (useDirectDocumentIngest) {
      const effectiveUserId = verifiedUsername;
      if (conversationId) {
        await setStreamingState(effectiveUserId, conversationId, jobId);
        await publishStreamingState(effectiveUserId, conversationId, true, jobId);
      }

      res.status(200).json({ jobId, status: 'pending' });
      startBackgroundDocumentIngest(
        jobId,
        jobRequest,
        verifiedUsername,
      ).catch((err) => {
        logger.error(`Job ${jobId}: Background document ingest failed`, err);
      });
      return;
    }

    // Set streaming state for cross-session UI
    const effectiveUserId = verifiedUsername;
    if (conversationId) {
      await setStreamingState(effectiveUserId, conversationId, jobId);
      await publishStreamingState(effectiveUserId, conversationId, true, jobId);
    }

    // Respond immediately so the client can start polling / WS listening
    res.status(200).json({ jobId, status: 'pending' });

    return;
  } catch (error) {
    if (error instanceof ApiRouteError) {
      logger.warn(`Rejected async job request: ${error.message}`, {
        status: error.status,
        reason: error.reason,
      });
      return res.status(error.status).json({
        error: error.message,
        reason: error.reason,
      });
    }
    logger.error('Error creating async job', error);
    return res.status(500).json({ error: 'Failed to create job' });
  }
}

// ── GET: Poll job status from NAT, finalize on completion ────────────

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const { jobId } = req.query;

  if (!jobId || typeof jobId !== 'string') {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  try {
    const session = await getSession(req, res);
    if (!session?.username) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const statusKey = sessionKey(['async-job-status', jobId]);
    const jobStatus = await jsonGet(statusKey) as AsyncJobStatus | null;

    if (!jobStatus) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const jobRequest = await jsonGet(sessionKey(['async-job-request', jobId])) as AsyncJobRequest | null;
    if (!jobRequest || jobRequest.userId !== session.username) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // If already finalized, return cached status immediately
    if ((jobStatus.status === 'completed' || jobStatus.status === 'error') && jobStatus.finalizedAt) {
      const sanitized = await sanitizeJobStatusForReturn(jobId, jobStatus, jobRequest);
      return res.status(200).json(sanitized);
    }

    if (jobRequest.executionMode === 'stream') {
      const lastActivityAt = jobStatus.updatedAt || jobStatus.createdAt;
      if (
        !isTerminalJobStatus(jobStatus.status) &&
        isPlausibleUnixMs(lastActivityAt) &&
        Date.now() - lastActivityAt > STREAM_JOB_STALE_TIMEOUT_MS
      ) {
        await finalizeError(
          jobId,
          jobRequest,
          'Backend stream did not produce an update before the timeout. Please try again.',
        );
        const updated = (await jsonGet(statusKey) as AsyncJobStatus | null) || jobStatus;
        const sanitized = await sanitizeJobStatusForReturn(jobId, updated, jobRequest);
        return res.status(200).json(sanitized);
      }
      const sanitized = await sanitizeJobStatusForReturn(jobId, jobStatus, jobRequest);
      return res.status(200).json(sanitized);
    }

    if (jobRequest.executionMode === 'document_ingest') {
      const sanitized = await sanitizeJobStatusForReturn(jobId, jobStatus, jobRequest);
      return res.status(200).json(sanitized);
    }

    // Fetch live status from NAT
    launchBackgroundFinalizer(jobId, jobRequest);

    let natStatus: NatAsyncJobResponse | null = null;

    try {
      natStatus = await fetchNatJobStatus(jobId, jobRequest);
    } catch (err) {
      logger.error(`Job ${jobId}: Failed to fetch NAT status`, err);
      // Return cached status on transient error -- polling will retry
      const sanitized = await sanitizeJobStatusForReturn(jobId, jobStatus, jobRequest);
      return res.status(200).json(sanitized);
    }

    if (!natStatus) {
      const sanitized = await sanitizeJobStatusForReturn(jobId, jobStatus, jobRequest);
      return res.status(200).json(sanitized);
    }

    const mappedStatus = mapNatStatus(natStatus.status);

    // Merge live intermediate steps from the background stream reader
    const stepsKey = sessionKey(['async-job-steps', jobId]);
    const liveSteps = await jsonGet(stepsKey) as any[] | null;

    // Still in progress
    if (mappedStatus === 'pending' || mappedStatus === 'streaming') {
      await updateJobStatus(jobId, {
        status: mappedStatus,
        progress: mappedStatus === 'streaming' ? 50 : 0,
        ...clearOAuthStatusFields(),
        ...(liveSteps?.length ? { intermediateSteps: liveSteps } : {}),
        updatedAt: Date.now(),
      });
      const updated = (await jsonGet(statusKey) as AsyncJobStatus | null) || jobStatus;
      const sanitized = await sanitizeJobStatusForReturn(jobId, updated, jobRequest);
      return res.status(200).json(sanitized);
    }

    // Failed or expired
    if (mappedStatus === 'error') {
      const updated = await finalizeFromNatStatus(jobId, jobRequest, natStatus);
      const sanitized = await sanitizeJobStatusForReturn(jobId, updated || jobStatus, jobRequest);
      return res.status(200).json(sanitized);
    }

    const finalStatus = await finalizeFromNatStatus(jobId, jobRequest, natStatus);
    const sanitized = await sanitizeJobStatusForReturn(jobId, finalStatus || jobStatus, jobRequest);
    return res.status(200).json(sanitized);
  } catch (error) {
    logger.error('Error fetching job status', error);
    return res.status(500).json({ error: 'Failed to fetch job status' });
  }
}

// ── DELETE: Cancel job ───────────────────────────────────────────────

async function handleDelete(req: NextApiRequest, res: NextApiResponse) {
  const { jobId } = req.query;

  if (!jobId || typeof jobId !== 'string') {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  try {
    const session = await getSession(req, res);
    if (!session?.username) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const requestKey = sessionKey(['async-job-request', jobId]);
    const statusKey = sessionKey(['async-job-status', jobId]);
    const stepsKey = sessionKey(['async-job-steps', jobId]);
    const jobRequest = await jsonGet(requestKey) as AsyncJobRequest | null;
    if (!jobRequest || jobRequest.userId !== session.username) {
      return res.status(404).json({ error: 'Job not found' });
    }
    const currentStatus = await jsonGet(statusKey) as AsyncJobStatus | null;

    await jsonSetWithExpiry(abortKey(jobId), true, JOB_EXPIRY_SECONDS).catch(() => {});

    // Clear streaming state if we have context
    if (jobRequest?.conversationId && jobRequest?.userId) {
      await clearStreamingState(jobRequest.userId, jobRequest.conversationId).catch(() => {});
      await publishStreamingState(jobRequest.userId, jobRequest.conversationId, false, jobId as string).catch(() => {});
    }

    if (currentStatus && !currentStatus.finalizedAt) {
      const streamSteps = await jsonGet(stepsKey) as any[] | null;
      const partialResponse = stripReplayedAssistantPrefix(
        currentStatus.partialResponse || '',
        jobRequest.messages || [],
      );
      await updateJobStatus(jobId, {
        status: 'error',
        error: 'Job canceled by user',
        partialResponse,
        ...clearOAuthStatusFields(),
        intermediateSteps: streamSteps?.length
          ? streamSteps
          : (currentStatus.intermediateSteps || []),
        updatedAt: Date.now(),
        finalizedAt: Date.now(),
      });
    }

    await Promise.all([jsonDel(requestKey), jsonDel(stepsKey)]);

    // NOTE: NAT async does not expose a cancel endpoint.
    // The Dask job runs to completion but the job is marked as canceled in Redis.
    // NAT's expiry_seconds ensures backend cleanup.

    return res.status(200).json({ success: true, canceled: true });
  } catch (error) {
    logger.error('Error canceling job', error);
    return res.status(500).json({ error: 'Failed to cancel job' });
  }
}

// ── Finalization helpers ─────────────────────────────────────────────

async function finalizeSuccess(
  jobId: string,
  jobRequest: AsyncJobRequest,
  rawOutput: string
): Promise<void> {
  const userId = jobRequest.userId;

  // Retrieve intermediate steps accumulated by the background stream reader
  const stepsKey = sessionKey(['async-job-steps', jobId]);
  const accumulatedSteps = (await jsonGet(stepsKey) as any[] | null) || [];

  // Process base64 images in the response
  const finalOutput = stripReplayedAssistantPrefix(rawOutput, jobRequest.messages || []);
  let processedContent = finalOutput;
  try {
    const { processMarkdownImages } = await import('@/utils/app/imageHandler');
    processedContent = await processMarkdownImages(finalOutput);
    if (processedContent !== finalOutput) {
      logger.info(`Job ${jobId}: Replaced base64 images with Redis references`);
    }
  } catch (error) {
    logger.error(`Job ${jobId}: Failed to process images`, error);
  }

  // Save conversation to Redis
  if (jobRequest.conversationId) {
    try {
      const conversationName = jobRequest.conversationName || 'New Conversation';
      const assistantMessage: Message = {
        id: jobRequest.assistantMessageId || uuidv4(),
        role: 'assistant',
        content: (processedContent && processedContent.trim()) || '[No response was generated]',
        intermediateSteps: accumulatedSteps,
        metadata: {
          ...(jobRequest.turnId ? { turnId: jobRequest.turnId } : {}),
          jobId,
        },
      };
      const allMessages = [...(jobRequest.messages || []), assistantMessage];
      const conversationData = sanitizeConversationAssistantReplays({
        id: jobRequest.conversationId,
        name: conversationName,
        folderId: null,
        messages: allMessages,
        updatedAt: Date.now(),
        isPartial: false,
        completedAt: Date.now(),
      });

      const conversationKey = sessionKey(['conversation', jobRequest.conversationId]);
      await jsonSetWithExpiry(conversationKey, conversationData, 60 * 60 * 24 * 7);

      // Update selected conversation if it matches
      const selectedConvKey = sessionKey(['user', userId, 'selectedConversation']);
      const selectedConv = await jsonGet(selectedConvKey) as any;
      if (selectedConv?.id === jobRequest.conversationId) {
        await jsonSetWithExpiry(selectedConvKey, sanitizeConversationAssistantReplays({
          ...selectedConv,
          messages: conversationData.messages,
          name: conversationName,
          updatedAt: Date.now(),
        }), 60 * 60 * 24 * 7);
        logger.info(`Job ${jobId}: Updated selected conversation for user ${userId}`);
      }

      logger.info(`Job ${jobId}: Saved conversation ${jobRequest.conversationId} with ${conversationData.messages.length} messages (${accumulatedSteps.length} steps)`);

      // Clear streaming state and publish WS events
      await clearStreamingState(userId, jobRequest.conversationId);
      await publishStreamingState(userId, jobRequest.conversationId, false, jobId);
      await publishConversationUpdate(userId, conversationData);

      // Publish chat_complete for WS streaming
      const tokenChannel = `user:${userId}:chat:${jobRequest.conversationId}:tokens`;
      getPublisher().publish(tokenChannel, JSON.stringify({
        type: 'chat_complete',
        conversationId: jobRequest.conversationId,
        jobId,
        turnId: jobRequest.turnId,
        assistantMessageId: assistantMessage.id,
        fullResponse: processedContent,
        intermediateSteps: accumulatedSteps,
      })).catch(() => {});

    } catch (error) {
      logger.error(`Job ${jobId}: Failed to save conversation`, error);
      // Clear streaming state even on error
      if (jobRequest.conversationId) {
        await clearStreamingState(userId, jobRequest.conversationId).catch(() => {});
        await publishStreamingState(userId, jobRequest.conversationId, false, jobId).catch(() => {});
      }
    }
  }

  // Update job status to completed
  await updateJobStatus(jobId, {
    status: 'completed',
    fullResponse: processedContent,
    partialResponse: undefined,
    ...clearOAuthStatusFields(),
    intermediateSteps: accumulatedSteps,
    progress: 100,
    turnId: jobRequest.turnId,
    assistantMessageId: jobRequest.assistantMessageId,
    updatedAt: Date.now(),
    finalizedAt: Date.now(),
  });

  // Clean up steps key
  await jsonDel(stepsKey).catch(() => {});

  logger.info(`Job ${jobId}: Finalized successfully (${accumulatedSteps.length} steps)`);

  // Send push notification
  try {
    const webpush = await import('web-push');
    const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
    if (vapidPublicKey && vapidPrivateKey && userId) {
      webpush.setVapidDetails('mailto:noreply@daedalus.app', vapidPublicKey, vapidPrivateKey);
      const subsKey = sessionKey(['user', userId, 'push-subscriptions']);
      const subscriptions = await jsonGet(subsKey);
      if (Array.isArray(subscriptions) && subscriptions.length > 0) {
        const payload = JSON.stringify({
          title: 'Response Ready',
          body: 'Your conversation has a new response',
          data: { conversationId: jobRequest.conversationId },
        });
        for (const sub of subscriptions) {
          webpush.sendNotification(sub, payload).catch((err: any) => {
            logger.warn(`Push notification failed: ${err.statusCode}`);
          });
        }
      }
    }
  } catch (pushError) {
    logger.debug('Push notification skipped', pushError);
  }
}

async function finalizeError(
  jobId: string,
  jobRequest: AsyncJobRequest,
  errorMessage: string
): Promise<void> {
  // Signal the stream reader to stop (mirrors the abort set in handleGet for
  // error paths that bypass handleGet's abort logic, e.g. direct calls).
  await jsonSetWithExpiry(abortKey(jobId), true, JOB_EXPIRY_SECONDS).catch(() => {});

  const userId = jobRequest.userId;

  // Read current job status to preserve any partial progress accumulated during polling
  const statusKey = sessionKey(['async-job-status', jobId]);
  const currentStatus = await jsonGet(statusKey) as AsyncJobStatus | null;
  const partialResponse = stripReplayedAssistantPrefix(
    currentStatus?.partialResponse || '',
    jobRequest.messages || [],
  );

  // Prefer steps from the background stream reader (stored separately),
  // fall back to whatever the job status already has
  const stepsKey = sessionKey(['async-job-steps', jobId]);
  const streamSteps = await jsonGet(stepsKey) as any[] | null;
  const intermediateSteps = streamSteps?.length
    ? streamSteps
    : (currentStatus?.intermediateSteps || []);

  // Save partial conversation to Redis so progress survives page refresh
  if (jobRequest.conversationId) {
    try {
      const conversationName = jobRequest.conversationName || 'New Conversation';
      let processedContent = partialResponse;
      if (partialResponse) {
        try {
          const { processMarkdownImages } = await import('@/utils/app/imageHandler');
          processedContent = await processMarkdownImages(partialResponse);
        } catch {
          // Image processing failure is non-critical for error path
        }
      }

      const assistantMessage: Message = {
        id: jobRequest.assistantMessageId || uuidv4(),
        role: 'assistant',
        content: (processedContent && processedContent.trim()) || '[Error occurred before response was generated]',
        intermediateSteps,
        metadata: {
          ...(jobRequest.turnId ? { turnId: jobRequest.turnId } : {}),
          jobId,
        },
        errorMessages: {
          message: errorMessage,
          timestamp: Date.now(),
          recoverable: true,
        },
      };
      const allMessages = [...(jobRequest.messages || []), assistantMessage];
      const conversationData = sanitizeConversationAssistantReplays({
        id: jobRequest.conversationId,
        name: conversationName,
        folderId: null,
        messages: allMessages,
        updatedAt: Date.now(),
        isPartial: true,
        error: errorMessage,
        completedAt: Date.now(),
      });

      const conversationKey = sessionKey(['conversation', jobRequest.conversationId]);
      await jsonSetWithExpiry(conversationKey, conversationData, 60 * 60 * 24 * 7);

      // Update selected conversation if it matches
      const selectedConvKey = sessionKey(['user', userId, 'selectedConversation']);
      const selectedConv = await jsonGet(selectedConvKey) as any;
      if (selectedConv?.id === jobRequest.conversationId) {
        await jsonSetWithExpiry(selectedConvKey, sanitizeConversationAssistantReplays({
          ...selectedConv,
          messages: conversationData.messages,
          name: conversationName,
          updatedAt: Date.now(),
        }), 60 * 60 * 24 * 7);
      }

      logger.info(`Job ${jobId}: Saved partial conversation ${jobRequest.conversationId} (${partialResponse ? partialResponse.length + ' chars' : 'no content'}, ${intermediateSteps.length} steps) with error`);

      await clearStreamingState(userId, jobRequest.conversationId).catch(() => {});
      await publishStreamingState(userId, jobRequest.conversationId, false, jobId).catch(() => {});
      await publishConversationUpdate(userId, conversationData).catch(() => {});

      // Publish chat_complete with error context so WS clients render partial results
      const tokenChannel = `user:${userId}:chat:${jobRequest.conversationId}:tokens`;
      getPublisher().publish(tokenChannel, JSON.stringify({
        type: 'chat_complete',
        conversationId: jobRequest.conversationId,
        jobId,
        turnId: jobRequest.turnId,
        assistantMessageId: assistantMessage.id,
        fullResponse: processedContent,
        intermediateSteps,
        error: errorMessage,
      })).catch(() => {});

    } catch (saveError) {
      logger.error(`Job ${jobId}: Failed to save partial conversation on error`, saveError);
      // Still clear streaming state even if save fails
      await clearStreamingState(userId, jobRequest.conversationId).catch(() => {});
      await publishStreamingState(userId, jobRequest.conversationId, false, jobId).catch(() => {});
    }
  }

  await updateJobStatus(jobId, {
    status: 'error',
    error: errorMessage,
    partialResponse,
    ...clearOAuthStatusFields(),
    intermediateSteps,
    turnId: jobRequest.turnId,
    assistantMessageId: jobRequest.assistantMessageId,
    updatedAt: Date.now(),
    finalizedAt: Date.now(),
  });

  // Clean up steps key
  await jsonDel(stepsKey).catch(() => {});

  logger.info(`Job ${jobId}: Finalized with error: ${errorMessage} (${intermediateSteps.length} steps preserved)`);
}

async function updateJobStatus(jobId: string, updates: Partial<AsyncJobStatus>): Promise<void> {
  const statusKey = sessionKey(['async-job-status', jobId]);
  const isTerminalWrite =
    updates.status === 'completed' || updates.status === 'error' || updates.finalizedAt !== undefined;

  const applied = await withRedisLock(
    statusLockKey(jobId),
    STATUS_UPDATE_LOCK_TTL_MS,
    async () => {
      const currentStatus = await jsonGet(statusKey) as AsyncJobStatus | null;

      if (!currentStatus) {
        logger.error('Job status not found for update', jobId);
        return false;
      }

      // Finalization guard: prevent the background stream reader from flipping a
      // completed/errored job back to 'streaming' after finalizeSuccess has run.
      // Only terminal status writes (completed / error) are allowed through.
      if (
        currentStatus.finalizedAt &&
        updates.status !== undefined &&
        updates.status !== 'completed' &&
        updates.status !== 'error'
      ) {
        logger.debug(
          `Job ${jobId}: Ignoring status update (status=${updates.status}) — job already finalized`,
        );
        return false;
      }

      const updatedStatus: AsyncJobStatus = {
        ...currentStatus,
        ...updates,
      };

      if (JSON.stringify(updatedStatus) === JSON.stringify(currentStatus)) {
        return false;
      }

      await jsonSetWithExpiry(statusKey, updatedStatus, JOB_EXPIRY_SECONDS);

      // Publish status update via Redis Pub/Sub for WebSocket sidecar
      try {
        const publisher = getPublisher();
        await publisher.publish(`job:${jobId}:status`, JSON.stringify(updatedStatus));
      } catch (err) {
        logger.error(`Failed to publish job status for ${jobId}`, err);
      }
      return true;
    },
    {
      retries: isTerminalWrite ? 20 : 1,
      retryDelayMs: isTerminalWrite ? 25 : 10,
    },
  );

  if (applied === null && isTerminalWrite) {
    logger.warn(`Job ${jobId}: Failed to acquire status lock for terminal update`);
  }
}
