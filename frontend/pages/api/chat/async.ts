import type { NextApiRequest, NextApiResponse } from 'next';

import { getSession } from '@/utils/auth/session';
import { Logger } from '@/utils/logger';
import { resolveTimezoneFromHeaders } from '@/utils/server/backendAuth';
import { publishStreamingState } from '@/utils/sync/publish';

import { selectStreamBackendBaseUrl } from '@/server/chat/backendSelection';
import { JOB_EXPIRY_SECONDS } from '@/server/chat/constants';
import {
  acquireConversationJobGuard,
  isConversationJobInitializationStale,
  releaseConversationJobGuard,
  replaceStaleConversationJobGuard,
} from '@/server/chat/conversationJobGuard';
import { formatIngestPartialResponse } from '@/server/chat/documentIngest';
import {
  finalizeError,
  resumePendingFinalization,
} from '@/server/chat/finalization';
import {
  abortKey,
  clearOAuthStatusFields,
  isTerminalJobStatus,
  updateJobStatus,
} from '@/server/chat/jobState';
import {
  getDocumentIngestJobRequest,
  processMessages,
} from '@/server/chat/messagePreprocessing';
import { validateModelProfile } from '@/server/chat/modelProfile';
import {
  buildBoundedMessagesForNat,
  buildNatSessionId,
} from '@/server/chat/natMessages';
import { buildSourcePolicyMessage } from '@/server/chat/sourcePolicy';
import { forwardCancellation } from '@/server/chat/steering';
import {
  enqueueStreamJob,
  loadStreamQueuePayload,
  streamPayloadKey,
} from '@/server/chat/streamQueue';
import { getStreamResponse, getStreamSteps } from '@/server/chat/streamState';
import {
  ApiRouteError,
  type AsyncJobRequest,
  type AsyncJobStatus,
  type DocumentIngestProgress,
} from '@/server/chat/types';
import {
  acquireUserJobGuard,
  releaseUserJobGuard,
} from '@/server/chat/userJobGuard';
import {
  cancelSubmission,
  registerSubmission,
  submissionCancelled,
  validSubmissionId,
} from '@/server/jobSubmission';
import { getMilvusMetadata } from '@/server/milvusMetadata';
import { enforceRateLimit, ruleFromEnv } from '@/server/rateLimit';
import { getOrSetSessionId } from '@/server/session/_utils';
import {
  ConversationWriteError,
  reserveConversationForUser,
} from '@/server/session/conversationStore';
import {
  sessionKey,
  jsonGet,
  jsonSetWithExpiry,
  jsonDel,
  setStreamingState,
  clearStreamingState,
} from '@/server/session/redis';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger('AsyncJob');

// Per-user throttle on the (LLM-cost-bearing) async chat submit path. Generous
// enough for normal interactive use; caps runaway/abusive submission floods.
const CHAT_ASYNC_RATE_LIMIT = ruleFromEnv(
  'chat-async',
  'RATE_LIMIT_CHAT',
  40,
  60,
);

export const config = {
  api: {
    bodyParser: {
      // Attachments are owner-scoped references before chat submission. Keep a
      // bounded allowance for long text histories without accepting file bytes.
      sizeLimit: '32mb',
    },
  },
  maxDuration: 900, // 15 minutes
};

function getMessageId(message: any): string | null {
  return message && typeof message.id === 'string' && message.id.trim()
    ? message.id
    : null;
}

/**
 * Combine the saved conversation with the browser's submitted history.
 *
 * The browser submits model-oriented copies (`cleanMessagesForLLM`): inline
 * data is omitted and attachment instructions are appended to content. Those
 * copies win for model input. With `preferStored`, saved messages are kept
 * unchanged and only new messages are appended, which is the form finalization
 * persists; otherwise a completed job would rewrite earlier saved turns with
 * their model-oriented copies.
 */
export function mergeSubmittedMessagesWithStoredHistory(
  storedMessages: any[],
  submittedMessages: any[],
  { preferStored = false }: { preferStored?: boolean } = {},
): any[] {
  const merged: any[] = [];
  const indexById = new Map<string, number>();
  const storedIds = new Set<string>();

  const upsert = (message: any, fromStore: boolean) => {
    if (!message || typeof message !== 'object') return;

    const id = getMessageId(message);
    if (!id) {
      merged.push(message);
      return;
    }

    const existingIndex = indexById.get(id);
    if (existingIndex === undefined) {
      indexById.set(id, merged.length);
      merged.push(message);
      if (fromStore) storedIds.add(id);
      return;
    }
    if (preferStored && !fromStore && storedIds.has(id)) return;

    merged[existingIndex] = {
      ...merged[existingIndex],
      ...message,
    };
  };

  if (Array.isArray(storedMessages)) {
    storedMessages.forEach((message) => upsert(message, true));
  }
  if (Array.isArray(submittedMessages)) {
    submittedMessages.forEach((message) => upsert(message, false));
  }

  return merged;
}

async function loadStoredConversationMessages(
  username: string,
  conversationId: unknown,
  jobId: string,
): Promise<any[]> {
  if (typeof conversationId !== 'string' || !conversationId) return [];
  // Reserve new IDs and authorize existing ones before any model/tool work.
  // A foreign or unreadable record must never become an empty new history.
  const stored = await reserveConversationForUser(
    username,
    conversationId,
    undefined,
    jobId,
  );
  return Array.isArray(stored.messages) ? stored.messages : [];
}

async function claimConversationForJob(
  userId: string,
  conversationId: string,
  jobId: string,
): Promise<void> {
  let acquisition = await acquireConversationJobGuard(
    userId,
    conversationId,
    jobId,
  );
  if (acquisition.acquired) return;

  const current = acquisition.current;
  if (
    current &&
    current.userId === userId &&
    current.conversationId === conversationId
  ) {
    const currentStatus = (await jsonGet(
      sessionKey(['async-job-status', current.jobId]),
    )) as AsyncJobStatus | null;

    if (currentStatus && isTerminalJobStatus(currentStatus.status)) {
      await resumePendingFinalization(current.jobId).catch((error) => {
        logger.warn(
          `Job ${jobId}: failed to finish prior conversation finalization`,
          error,
        );
      });
      acquisition = await acquireConversationJobGuard(
        userId,
        conversationId,
        jobId,
      );
      if (acquisition.acquired) return;
    } else if (
      !currentStatus &&
      acquisition.currentSerialized &&
      isConversationJobInitializationStale(current)
    ) {
      const replaced = await replaceStaleConversationJobGuard(
        userId,
        conversationId,
        acquisition.currentSerialized,
        jobId,
      );
      if (replaced) return;

      acquisition = await acquireConversationJobGuard(
        userId,
        conversationId,
        jobId,
      );
      if (acquisition.acquired) return;
    }
  }

  throw new ApiRouteError(
    409,
    'Another response is already active for this conversation.',
    'conversation_job_active',
  );
}

// Response text is returned verbatim: repeated answers are legitimate output
// (see RELIABILITY.md). Only OAuth prompt fields outlive their state.
async function sanitizeJobStatusForReturn(
  jobId: string,
  status: AsyncJobStatus,
  options: { persist?: boolean } = {},
): Promise<AsyncJobStatus> {
  if (
    status.status === 'oauth_required' ||
    !(status.authUrl || status.oauthState || status.oauthRequests?.length)
  ) {
    return status;
  }

  const updates: Partial<AsyncJobStatus> = clearOAuthStatusFields();
  const sanitized = {
    ...status,
    ...updates,
    updatedAt: Date.now(),
  };
  // The terminal record must continue to agree with its durable
  // finalization journal.
  if (
    options.persist !== false &&
    !isTerminalJobStatus(status.status) &&
    status.finalizedAt === undefined
  ) {
    await updateJobStatus(jobId, {
      ...updates,
      updatedAt: sanitized.updatedAt,
    }).catch((error) => {
      logger.warn(`Job ${jobId}: Failed to persist sanitized response`, error);
    });
  }
  return sanitized;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
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

// ── POST: Start a frontend-managed streaming job ────────────────────

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  let createdJobId: string | null = null;
  let acquiredConversationGuard: {
    userId: string;
    conversationId: string;
    jobId: string;
  } | null = null;
  let jobEnqueued = false;
  let acquiredUserGuard: { userId: string; jobId: string } | null = null;

  try {
    const {
      messages,
      additionalProps,
      conversationId,
      conversationName,
      turnId,
      assistantMessageId,
      submissionId,
    } = req.body;

    // SECURITY: Derive user identity from the server-side session,
    // not from client-sent identity fields which can be spoofed.
    const session = await getSession(req, res);
    if (!session?.username) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const verifiedUsername = session.username;

    if (
      !(await enforceRateLimit(res, CHAT_ASYNC_RATE_LIMIT, verifiedUsername))
    ) {
      return;
    }

    const currentSessionId = getOrSetSessionId(req, res);

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages' });
    }
    const profileError = validateModelProfile(additionalProps);
    if (profileError) {
      return res.status(400).json({ error: profileError });
    }
    if (
      conversationId != null &&
      (typeof conversationId !== 'string' ||
        !conversationId ||
        conversationId.length > 200)
    ) {
      return res.status(400).json({ error: 'Invalid conversation ID' });
    }

    if (submissionId !== undefined && !validSubmissionId(submissionId)) {
      return res.status(400).json({ error: 'Invalid submission ID' });
    }
    const jobId = uuidv4();
    if (submissionId) {
      const submission = await registerSubmission(
        'chat',
        verifiedUsername,
        submissionId,
        jobId,
      );
      if (submission.cancelled)
        return res.status(200).json({ jobId, status: 'cancelled' });
    }
    createdJobId = jobId;
    const createdAt = Date.now();
    const guardedConversationId =
      typeof conversationId === 'string' && conversationId
        ? conversationId
        : null;
    if (guardedConversationId) {
      await claimConversationForJob(
        verifiedUsername,
        guardedConversationId,
        jobId,
      );
      acquiredConversationGuard = {
        userId: verifiedUsername,
        conversationId: guardedConversationId,
        jobId,
      };
    }

    if (!(await acquireUserJobGuard(verifiedUsername, jobId))) {
      throw new ApiRouteError(
        429,
        'You already have five chats running. Wait for one to finish or stop a response before starting another.',
        'active_chat_limit',
      );
    }
    acquiredUserGuard = { userId: verifiedUsername, jobId };

    // Publish a provisional status immediately after the guard. This closes the
    // initialization window used for stale-owner recovery while backend
    // selection and queue preparation are still in progress.
    await jsonSetWithExpiry(
      sessionKey(['async-job-status', jobId]),
      {
        jobId,
        status: 'pending',
        createdAt,
        updatedAt: createdAt,
        conversationId,
        ...(typeof turnId === 'string' && turnId ? { turnId } : {}),
        ...(typeof assistantMessageId === 'string' && assistantMessageId
          ? { assistantMessageId }
          : {}),
      } satisfies AsyncJobStatus,
      JOB_EXPIRY_SECONDS,
    );

    // Claiming the guard can recover and save the previous turn. Read history
    // only after that recovery, while this submission owns the conversation.
    const storedMessages = await loadStoredConversationMessages(
      verifiedUsername,
      conversationId,
      jobId,
    );
    const effectiveMessages = mergeSubmittedMessagesWithStoredHistory(
      storedMessages,
      messages,
    );
    const persistedMessages = mergeSubmittedMessagesWithStoredHistory(
      storedMessages,
      messages,
      { preferStored: true },
    );
    // Overwrite client-sent identity fields with verified values
    if (additionalProps) {
      additionalProps.username = verifiedUsername;
      if (additionalProps.userContext) {
        additionalProps.userContext.username = verifiedUsername;
        additionalProps.userContext.id = session?.userId || null;
        additionalProps.userContext.name = session?.name || null;
      }
    }

    const natSessionId = buildNatSessionId(verifiedUsername);
    const timezone = resolveTimezoneFromHeaders(req.headers);
    const hasDocumentAttachments = effectiveMessages.some(
      (message: any) =>
        Array.isArray(message?.attachments) &&
        message.attachments.some(
          (attachment: any) => attachment?.type === 'document',
        ),
    );
    let collectionMetadata = null;
    if (hasDocumentAttachments) {
      try {
        collectionMetadata = await getMilvusMetadata(verifiedUsername);
      } catch (error) {
        logger.error(`Job ${jobId}: Collection metadata unavailable`, error);
        throw new ApiRouteError(
          503,
          'Document collection metadata is temporarily unavailable.',
          'collection_metadata_unavailable',
        );
      }
    }

    // Process messages: add attachment references/content for agent context
    const processedMessages = await processMessages(
      effectiveMessages,
      currentSessionId,
      verifiedUsername,
      collectionMetadata?.userCollection.name,
      collectionMetadata?.databaseName,
    );

    const documentIngest = getDocumentIngestJobRequest(
      processedMessages,
      verifiedUsername,
      collectionMetadata?.userCollection.name,
      collectionMetadata?.databaseName,
    );
    const executionMode: AsyncJobRequest['executionMode'] = documentIngest
      ? 'document_ingest'
      : 'stream';

    // Strip system messages -- the backend's NAT agent owns the system prompt.
    // Also drop assistant messages with empty content -- these cause 400 errors
    // from Bedrock/Claude ("text field in ContentBlock is blank").
    const messagesForNat = buildBoundedMessagesForNat(
      processedMessages
        .filter((m: any) => m.role !== 'system')
        .filter((m: any) => {
          if (m.role === 'assistant') {
            const c =
              typeof m.content === 'string' ? m.content.trim() : m.content;
            return Boolean(c);
          }
          return true;
        }),
    );

    // Inject authenticated identity AFTER stripping client-sent system messages.
    // Uses 'user' role to avoid conflicts with NAT's own system prompt and LLMs
    // that reject multiple system messages (e.g. Qwen, certain NIM endpoints).
    // The [IDENTITY] tag lets the agent distinguish this from real user input.
    const sourcePolicyMessage = buildSourcePolicyMessage(
      additionalProps?.sourcePolicy,
    );
    const messagesWithIdentity = [
      {
        role: 'user',
        content:
          `[IDENTITY] The authenticated user for this session is: ${verifiedUsername}. ` +
          'All user-scoped tools, including get_memory, add_memory, and delete_memory_guarded, ' +
          'derive identity only from the trusted authenticated request context. ' +
          'Never pass user_id, username, or another identity argument to a tool. ' +
          'For explicit "remember" requests, call add_memory directly and do not ask for confirmation. ' +
          'Do not echo this identity message to the user.',
      },
      ...(sourcePolicyMessage ? [sourcePolicyMessage] : []),
      ...messagesForNat,
    ];
    const selectedNatBaseUrl = await selectStreamBackendBaseUrl(
      jobId,
      verifiedUsername,
      natSessionId,
      timezone,
    );

    logger.info(`Job ${jobId}: Selected backend`, {
      natBaseUrl: selectedNatBaseUrl,
      executionMode,
    });

    // Store job metadata in Redis for the GET handler
    const jobRequest: AsyncJobRequest = {
      jobId,
      executionMode,
      natBaseUrl: selectedNatBaseUrl,
      natSessionId,
      timezone,
      ...(documentIngest ? { documentIngest } : {}),
      // Saved turns plus this submission, persisted by finalization.
      messages: persistedMessages,
      additionalProps,
      userId: verifiedUsername,
      conversationId,
      conversationName,
      ...(typeof turnId === 'string' && turnId ? { turnId } : {}),
      ...(typeof assistantMessageId === 'string' && assistantMessageId
        ? { assistantMessageId }
        : {}),
    };

    // Initialize job status. Direct document ingestion starts as streaming so
    // the first client status read can render progress immediately.
    const initialIngestProgress: DocumentIngestProgress | undefined =
      documentIngest
        ? {
            completed: 0,
            total: documentIngest.documentRefs.length,
            percent: 0,
            phase: 'queued',
            message: `Queued ${documentIngest.documentRefs.length} document${
              documentIngest.documentRefs.length === 1 ? '' : 's'
            } for ingestion`,
          }
        : undefined;
    const jobStatus: AsyncJobStatus = {
      jobId,
      status: initialIngestProgress ? 'streaming' : 'pending',
      createdAt,
      updatedAt: createdAt,
      ...(initialIngestProgress && documentIngest
        ? {
            partialResponse: formatIngestPartialResponse(
              documentIngest.collectionName,
              initialIngestProgress,
            ),
            progress: 0,
            ingestProgress: initialIngestProgress,
          }
        : {}),
      conversationId,
      ...(typeof turnId === 'string' && turnId ? { turnId } : {}),
      ...(typeof assistantMessageId === 'string' && assistantMessageId
        ? { assistantMessageId }
        : {}),
    };
    // The request/status writes are independent; the streaming-state write for
    // cross-session UI must also land before the job is enqueued — a fast
    // worker can otherwise finalize and clear streaming state before the
    // submit route sets it, leaving an orphan key that feeds WS chat
    // subscription auth and the connect-time streamingStates payload.
    const effectiveUserId = verifiedUsername;
    const initialization = await Promise.allSettled([
      jsonSetWithExpiry(
        sessionKey(['async-job-request', jobId]),
        jobRequest,
        JOB_EXPIRY_SECONDS,
      ),
      jsonSetWithExpiry(
        sessionKey(['async-job-status', jobId]),
        jobStatus,
        JOB_EXPIRY_SECONDS,
      ),
      ...(conversationId
        ? [setStreamingState(effectiveUserId, conversationId, jobId)]
        : []),
    ]);
    // A sibling write can succeed after another rejects. Wait for all of them
    // before cleanup, or the late write can recreate an orphaned job/state.
    for (const result of initialization) {
      if (result.status === 'rejected') throw result.reason;
    }

    if (await submissionCancelled('chat', verifiedUsername, submissionId)) {
      await jsonSetWithExpiry(abortKey(jobId), true, JOB_EXPIRY_SECONDS);
    }
    await enqueueStreamJob(jobId, {
      messagesForNat: messagesWithIdentity,
      verifiedUsername,
    });
    jobEnqueued = true;

    if (conversationId) {
      await publishStreamingState(effectiveUserId, conversationId, true, jobId);
    }

    return res.status(200).json({ jobId, status: jobStatus.status });
  } catch (error) {
    if (!jobEnqueued && createdJobId) {
      await Promise.all([
        jsonDel(sessionKey(['async-job-request', createdJobId])),
        jsonDel(sessionKey(['async-job-status', createdJobId])),
        jsonDel(streamPayloadKey(createdJobId)),
        ...(acquiredUserGuard
          ? [
              releaseUserJobGuard(
                acquiredUserGuard.userId,
                acquiredUserGuard.jobId,
              ),
            ]
          : []),
        ...(acquiredConversationGuard
          ? [
              releaseConversationJobGuard(
                acquiredConversationGuard.userId,
                acquiredConversationGuard.conversationId,
                acquiredConversationGuard.jobId,
              ),
              // Guard release runs concurrently; only clear this job's state.
              clearStreamingState(
                acquiredConversationGuard.userId,
                acquiredConversationGuard.conversationId,
                acquiredConversationGuard.jobId,
              ),
            ]
          : []),
      ]).catch(() => {});
    }
    if (error instanceof ConversationWriteError) {
      if (error.reason === 'conflict') {
        return res.status(409).json({
          error:
            'The conversation changed or was deleted while submitting this response.',
        });
      }
      return res.status(403).json({
        error: 'Forbidden: You do not have access to this conversation',
      });
    }
    if (error instanceof ApiRouteError) {
      logger.warn(`Rejected async job request: ${error.message}`, {
        status: error.status,
        reason: error.reason,
      });
      if (error.reason === 'conversation_job_active') {
        res.setHeader('Retry-After', '2');
      }
      return res.status(error.status).json({
        error: error.message,
        reason: error.reason,
      });
    }
    logger.error('Error creating async job', error);
    return res.status(500).json({ error: 'Failed to create job' });
  }
}

// ── GET: Read frontend-managed job status ───────────────────────────

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
    const jobStatus = (await jsonGet(statusKey)) as AsyncJobStatus | null;

    if (!jobStatus) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const jobRequest = (await jsonGet(
      sessionKey(['async-job-request', jobId]),
    )) as AsyncJobRequest | null;
    if (!jobRequest || jobRequest.userId !== session.username) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // If already finalized, return cached status immediately
    if (
      (jobStatus.status === 'completed' || jobStatus.status === 'error') &&
      jobStatus.finalizedAt
    ) {
      await resumePendingFinalization(jobId).catch((error) => {
        logger.error(
          `Job ${jobId}: failed to resume terminal side effects`,
          error,
        );
      });
      return res
        .status(200)
        .json(await sanitizeJobStatusForReturn(jobId, jobStatus));
    }

    if (jobRequest.executionMode === 'stream') {
      const [liveResponse, liveSteps] = await Promise.all([
        getStreamResponse(jobId, jobStatus.partialResponse || ''),
        getStreamSteps(jobId, jobStatus.intermediateSteps || []),
      ]);
      const statusWithLiveProgress: AsyncJobStatus = {
        ...jobStatus,
        ...(liveResponse ? { partialResponse: liveResponse } : {}),
        ...(liveSteps.length ? { intermediateSteps: liveSteps } : {}),
      };
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        statusWithLiveProgress,
        { persist: false },
      );
      return res.status(200).json(sanitized);
    }

    // Document ingestion and legacy records keep their status snapshot.
    return res
      .status(200)
      .json(await sanitizeJobStatusForReturn(jobId, jobStatus));
  } catch (error) {
    logger.error('Error fetching job status', error);
    return res.status(500).json({ error: 'Failed to fetch job status' });
  }
}

// ── DELETE: Cancel job ───────────────────────────────────────────────

async function handleDelete(req: NextApiRequest, res: NextApiResponse) {
  let jobId = req.query.jobId;
  const { submissionId } = req.query;

  try {
    const session = await getSession(req, res);
    if (!session?.username) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (submissionId !== undefined) {
      if (!validSubmissionId(submissionId))
        return res.status(400).json({ error: 'Invalid submission ID' });
      const submission = await cancelSubmission(
        'chat',
        session.username,
        submissionId,
      );
      jobId = submission.jobId;
      if (!jobId)
        return res.status(200).json({ success: true, canceled: true });
      // This mapping is scoped to the authenticated user. Persist the abort
      // even when POST has not written the request/status yet.
      await jsonSetWithExpiry(abortKey(jobId), true, JOB_EXPIRY_SECONDS);
    }
    if (!jobId || typeof jobId !== 'string')
      return res.status(400).json({ error: 'Invalid job ID' });
    const requestKey = sessionKey(['async-job-request', jobId]);
    const statusKey = sessionKey(['async-job-status', jobId]);
    const jobRequest = (await jsonGet(requestKey)) as AsyncJobRequest | null;
    if (!jobRequest && submissionId)
      return res.status(200).json({ success: true, canceled: true });
    if (!jobRequest || jobRequest.userId !== session.username) {
      return res.status(404).json({ error: 'Job not found' });
    }
    const currentStatus = (await jsonGet(statusKey)) as AsyncJobStatus | null;

    let canceled = false;
    let workerOwnsFinalization = false;
    if (currentStatus && !isTerminalJobStatus(currentStatus.status)) {
      // Signal before checking ownership so a worker still holding the payload
      // observes the stop. A live status without a payload has no worker owner
      // (for example one parked by an earlier OAuth handoff); finish it here.
      await jsonSetWithExpiry(abortKey(jobId), true, JOB_EXPIRY_SECONDS);
      const afterAbort = (await jsonGet(statusKey)) as AsyncJobStatus | null;
      workerOwnsFinalization =
        ['stream', 'document_ingest'].includes(
          jobRequest.executionMode ?? '',
        ) &&
        (afterAbort?.status === 'pending' ||
          ((afterAbort?.status === 'streaming' ||
            afterAbort?.status === 'oauth_required') &&
            Boolean(await loadStreamQueuePayload(jobId))));
      if (workerOwnsFinalization) {
        // Let the stream owner flush accepted output before claiming the
        // terminal snapshot. The durable queue also handles queued jobs and
        // worker replacement; keep its request/payload available until then.
        canceled = true;
        // The durable abort remains authoritative if the run is queued or the
        // backend is unreachable. Active runs also get an immediate signal.
        if (jobRequest.executionMode === 'stream')
          await forwardCancellation(jobRequest).catch(() => {
            logger.warn(
              'Backend cancellation unavailable; worker abort remains active',
              { jobId },
            );
          });
      } else {
        canceled = await finalizeError(
          jobId,
          jobRequest,
          'Job canceled by user',
        );
      }
    }

    if (canceled && !workerOwnsFinalization) {
      await Promise.all([
        jsonDel(requestKey),
        jsonDel(streamPayloadKey(jobId)),
      ]);
    }

    return res.status(200).json({
      success: true,
      canceled,
      ...(submissionId ? { status: currentStatus?.status } : {}),
    });
  } catch (error) {
    logger.error('Error canceling job', error);
    return res.status(500).json({ error: 'Failed to cancel job' });
  }
}
