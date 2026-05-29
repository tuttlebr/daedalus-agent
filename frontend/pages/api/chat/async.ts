import type { NextApiRequest, NextApiResponse } from 'next';

import { buildBackendBaseUrlForMode } from '@/utils/app/backendApi';
import { stripReplayedAssistantPrefix } from '@/utils/app/conversationReplay';
import { getSession } from '@/utils/auth/session';
import { Logger } from '@/utils/logger';
import { publishStreamingState } from '@/utils/sync/publish';

import {
  fetchNatJobStatus,
  selectStreamBackendBaseUrl,
  submitNatAsyncJob,
} from '@/server/chat/backendSelection';
import { launchBackgroundFinalizer } from '@/server/chat/backgroundFinalizer';
import {
  JOB_EXPIRY_SECONDS,
  STREAM_JOB_STALE_TIMEOUT_MS,
} from '@/server/chat/constants';
import {
  formatIngestPartialResponse,
  startBackgroundDocumentIngest,
} from '@/server/chat/documentIngest';
import {
  finalizeError,
  finalizeFromNatStatus,
} from '@/server/chat/finalization';
import {
  abortKey,
  clearOAuthStatusFields,
  isPlausibleUnixMs,
  isTerminalJobStatus,
  mapNatStatus,
  updateJobStatus,
} from '@/server/chat/jobState';
import {
  buildDocumentIngestNatMessages,
  getDocumentIngestJobRequest,
  processMessages,
} from '@/server/chat/messagePreprocessing';
import {
  buildBoundedMessagesForNat,
  buildNatSessionId,
} from '@/server/chat/natMessages';
import { startBackgroundStreamReader } from '@/server/chat/streamReader';
import {
  ApiRouteError,
  type AsyncJobRequest,
  type AsyncJobStatus,
  type DocumentIngestJobRequest,
  type DocumentIngestProgress,
  type NatAsyncJobResponse,
} from '@/server/chat/types';
import { getOrSetSessionId } from '@/server/session/_utils';
import {
  sessionKey,
  jsonGet,
  jsonSetWithExpiry,
  jsonDel,
  setStreamingState,
  clearStreamingState,
} from '@/server/session/redis';
import { v4 as uuidv4 } from 'uuid';

// Re-exported to preserve the historical public surface of this route module
// (the test suite imports these from '@/pages/api/chat/async').
export {
  extractAsyncStreamContentDelta,
  parseIntermediateDataLine,
} from '@/utils/app/asyncStepParser';
export {
  appendDocumentAttachmentContext,
  compactDocumentIngestionMessage,
  getDocumentIngestJobRequest,
  isDocumentIngestionRequest,
} from '@/server/chat/messagePreprocessing';
export {
  buildBoundedMessagesForNat,
  buildNatRequestHeaders,
  buildNatSessionId,
} from '@/server/chat/natMessages';
export {
  fetchNatJobStatus,
  resolveAsyncBackendBaseUrls,
} from '@/server/chat/backendSelection';

const logger = new Logger('AsyncJob');

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '300mb', // Support large document processing payloads
    },
  },
  maxDuration: 900, // 15 minutes
};

function isNatAsyncExecutionMode(
  mode: AsyncJobRequest['executionMode'],
): mode is 'nat_async' {
  return mode === 'nat_async' || mode === undefined;
}

function isDirectDocumentIngestStreamEnabled(): boolean {
  return process.env.DAEDALUS_DIRECT_DOCUMENT_INGEST_STREAM !== '0';
}

async function sanitizeJobStatusForReturn(
  jobId: string,
  status: AsyncJobStatus,
  jobRequest: AsyncJobRequest,
): Promise<AsyncJobStatus> {
  const updates: Partial<AsyncJobStatus> = {};

  if (
    status.status !== 'oauth_required' &&
    (status.authUrl || status.oauthState)
  ) {
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
    const processedMessages = await processMessages(
      messages,
      currentSessionId,
      verifiedUsername,
      jobId,
    );

    const documentIngest = getDocumentIngestJobRequest(
      processedMessages,
      verifiedUsername,
    );
    const useDirectDocumentIngest = Boolean(
      documentIngest && isDirectDocumentIngestStreamEnabled(),
    );
    const useNatAsyncJob = Boolean(documentIngest && !useDirectDocumentIngest);
    const executionMode: NonNullable<AsyncJobRequest['executionMode']> =
      useDirectDocumentIngest
        ? 'document_ingest'
        : useNatAsyncJob
        ? 'nat_async'
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
    const messagesWithIdentity = [
      {
        role: 'user',
        content:
          `[IDENTITY] The authenticated user for this session is: ${verifiedUsername}. ` +
          `Use user_id="${verifiedUsername}" for ALL memory operations ` +
          '(get_memory, add_memory, delete_memory_guarded), uploaded media ' +
          'tool calls that require user_id, and per-user Google Workspace MCP ' +
          'access. Do not echo this identity message to the user.',
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

    logger.info(`Job ${jobId}: Selected backend`, {
      natBaseUrl: selectedNatBaseUrl,
      executionMode,
    });

    // Store job metadata in Redis for the GET handler
    const jobRequest: AsyncJobRequest = {
      jobId,
      executionMode,
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
      ...(typeof assistantMessageId === 'string' && assistantMessageId
        ? { assistantMessageId }
        : {}),
    };

    if (useNatAsyncJob) {
      await submitNatAsyncJob(
        jobId,
        jobRequest.natBaseUrl,
        durableMessagesForNat,
        verifiedUsername,
        natSessionId,
      );
    }

    await jsonSetWithExpiry(
      sessionKey(['async-job-request', jobId]),
      jobRequest,
      JOB_EXPIRY_SECONDS,
    );

    // Initialize job status. Direct document ingestion starts as streaming so
    // the first client status read can render progress immediately.
    const createdAt = Date.now();
    const initialIngestProgress: DocumentIngestProgress | undefined =
      useDirectDocumentIngest && documentIngest
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
    await jsonSetWithExpiry(
      sessionKey(['async-job-status', jobId]),
      jobStatus,
      JOB_EXPIRY_SECONDS,
    );

    if (useDirectDocumentIngest) {
      const effectiveUserId = verifiedUsername;
      if (conversationId) {
        await setStreamingState(effectiveUserId, conversationId, jobId);
        await publishStreamingState(
          effectiveUserId,
          conversationId,
          true,
          jobId,
        );
      }

      res.status(200).json({ jobId, status: jobStatus.status });
      startBackgroundDocumentIngest(jobId, jobRequest, verifiedUsername).catch(
        (err) => {
          logger.error(`Job ${jobId}: Background document ingest failed`, err);
        },
      );
      return;
    }

    // Set streaming state for cross-session UI
    const effectiveUserId = verifiedUsername;
    if (conversationId) {
      await setStreamingState(effectiveUserId, conversationId, jobId);
      await publishStreamingState(effectiveUserId, conversationId, true, jobId);
    }

    // Respond immediately so the client can start polling / WS listening
    res.status(200).json({ jobId, status: jobStatus.status });

    if (!useNatAsyncJob) {
      startBackgroundStreamReader(
        jobId,
        jobRequest,
        durableMessagesForNat,
        verifiedUsername,
      ).catch((err) => {
        logger.error(`Job ${jobId}: Background stream reader failed`, err);
      });
    }

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
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        jobStatus,
        jobRequest,
      );
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
        const updated =
          ((await jsonGet(statusKey)) as AsyncJobStatus | null) || jobStatus;
        const sanitized = await sanitizeJobStatusForReturn(
          jobId,
          updated,
          jobRequest,
        );
        return res.status(200).json(sanitized);
      }
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        jobStatus,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    if (jobRequest.executionMode === 'document_ingest') {
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        jobStatus,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    if (!isNatAsyncExecutionMode(jobRequest.executionMode)) {
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        jobStatus,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    // Fetch live status from NAT for legacy durable async jobs.
    launchBackgroundFinalizer(jobId, jobRequest);

    let natStatus: NatAsyncJobResponse | null = null;

    try {
      natStatus = await fetchNatJobStatus(jobId, jobRequest);
    } catch (err) {
      logger.error(`Job ${jobId}: Failed to fetch NAT status`, err);
      // Return cached status on transient error -- polling will retry
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        jobStatus,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    if (!natStatus) {
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        jobStatus,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    const mappedStatus = mapNatStatus(natStatus.status);

    // Merge live intermediate steps from the background stream reader
    const stepsKey = sessionKey(['async-job-steps', jobId]);
    const liveSteps = (await jsonGet(stepsKey)) as any[] | null;

    // Still in progress
    if (mappedStatus === 'pending' || mappedStatus === 'streaming') {
      await updateJobStatus(jobId, {
        status: mappedStatus,
        progress: mappedStatus === 'streaming' ? 50 : 0,
        ...clearOAuthStatusFields(),
        ...(liveSteps?.length ? { intermediateSteps: liveSteps } : {}),
        updatedAt: Date.now(),
      });
      const updated =
        ((await jsonGet(statusKey)) as AsyncJobStatus | null) || jobStatus;
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        updated,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    // Failed or expired
    if (mappedStatus === 'error') {
      const updated = await finalizeFromNatStatus(jobId, jobRequest, natStatus);
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        updated || jobStatus,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    const finalStatus = await finalizeFromNatStatus(
      jobId,
      jobRequest,
      natStatus,
    );
    const sanitized = await sanitizeJobStatusForReturn(
      jobId,
      finalStatus || jobStatus,
      jobRequest,
    );
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
    const jobRequest = (await jsonGet(requestKey)) as AsyncJobRequest | null;
    if (!jobRequest || jobRequest.userId !== session.username) {
      return res.status(404).json({ error: 'Job not found' });
    }
    const currentStatus = (await jsonGet(statusKey)) as AsyncJobStatus | null;

    await jsonSetWithExpiry(abortKey(jobId), true, JOB_EXPIRY_SECONDS).catch(
      () => {},
    );

    // Clear streaming state if we have context
    if (jobRequest?.conversationId && jobRequest?.userId) {
      await clearStreamingState(
        jobRequest.userId,
        jobRequest.conversationId,
      ).catch(() => {});
      await publishStreamingState(
        jobRequest.userId,
        jobRequest.conversationId,
        false,
        jobId as string,
      ).catch(() => {});
    }

    if (currentStatus && !currentStatus.finalizedAt) {
      const streamSteps = (await jsonGet(stepsKey)) as any[] | null;
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
          : currentStatus.intermediateSteps || [],
        updatedAt: Date.now(),
        finalizedAt: Date.now(),
      });
    }

    await Promise.all([jsonDel(requestKey), jsonDel(stepsKey)]);

    // NOTE: NAT async does not expose a cancel endpoint. The backend run (an
    // asyncio task) continues to completion; we mark the job canceled in Redis
    // and set the abort flag so the stream reader stops publishing.
    // NAT's expiry_seconds ensures backend cleanup.

    return res.status(200).json({ success: true, canceled: true });
  } catch (error) {
    logger.error('Error canceling job', error);
    return res.status(500).json({ error: 'Failed to cancel job' });
  }
}
