import type { NextApiRequest, NextApiResponse } from 'next';

import { getSession } from '@/utils/auth/session';
import { Logger } from '@/utils/logger';
import { resolveTimezoneFromHeaders } from '@/utils/server/backendAuth';

import { cancelChatJob } from '@/server/chat/cancellation';
import { JOB_EXPIRY_SECONDS } from '@/server/chat/constants';
import {
  INVALID_CONVERSATION_ID_MESSAGE,
  isValidConversationId,
} from '@/server/chat/conversationId';
import { resumePendingFinalization } from '@/server/chat/finalization';
import {
  abortKey,
  clearOAuthStatusFields,
  isTerminalJobStatus,
  updateJobStatus,
} from '@/server/chat/jobState';
import { validateModelProfile } from '@/server/chat/modelProfile';
import { getStreamResponse, getStreamSteps } from '@/server/chat/streamState';
import { submitChatJob } from '@/server/chat/submission';
import {
  ApiRouteError,
  type AsyncJobRequest,
  type AsyncJobStatus,
} from '@/server/chat/types';
import { cancelSubmission, validSubmissionId } from '@/server/jobSubmission';
import { enforceRateLimit, ruleFromEnv } from '@/server/rateLimit';
import { getStorageSessionId } from '@/server/session/_utils';
import { ConversationWriteError } from '@/server/session/conversationStore';
import {
  getRedis,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';
import { JOB_ID_PATTERN, readJsonFields } from '@/server/session/redisShared';

export { mergeSubmittedMessagesWithStoredHistory } from '@/server/chat/submission';

const logger = new Logger('AsyncJob');

// Per-user throttle on the (LLM-cost-bearing) async chat submit path. Generous
// enough for normal interactive use; caps runaway/abusive submission floods.
// Compatibility API submissions share this bucket.
export const CHAT_ASYNC_RATE_LIMIT = ruleFromEnv(
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
};

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

    // Upload routes scope anonymous documents by this derived storage ID, never
    // by the raw session credential.
    const currentSessionId = getStorageSessionId(req, res);

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages' });
    }
    const profileError = validateModelProfile(additionalProps);
    if (profileError) {
      return res.status(400).json({ error: profileError });
    }
    if (conversationId != null && !isValidConversationId(conversationId)) {
      return res.status(400).json({
        error: INVALID_CONVERSATION_ID_MESSAGE,
        reason: 'invalid_conversation_id',
      });
    }

    if (submissionId !== undefined && !validSubmissionId(submissionId)) {
      return res.status(400).json({ error: 'Invalid submission ID' });
    }

    const result = await submitChatJob(
      {
        username: verifiedUsername,
        userId: session.userId,
        name: session.name,
      },
      {
        messages,
        additionalProps,
        conversationId,
        conversationName,
        turnId,
        assistantMessageId,
        submissionId,
        storageSessionId: currentSessionId,
        timezone: resolveTimezoneFromHeaders(req.headers),
      },
    );
    return res.status(200).json({ jobId: result.jobId, status: result.status });
  } catch (error) {
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

  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  try {
    const session = await getSession(req, res);
    if (!session?.username) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const statusKey = sessionKey(['async-job-status', jobId]);
    // Independent reads in one round trip. Ownership needs only two fields
    // of the request, which also carries the conversation history; live
    // output is returned only after ownership is confirmed.
    const [jobStatus, jobRequest, liveResponse, liveSteps] = await Promise.all([
      jsonGet(statusKey) as Promise<AsyncJobStatus | null>,
      readJsonFields<AsyncJobRequest>(
        getRedis(),
        sessionKey(['async-job-request', jobId]),
        ['userId', 'executionMode'],
      ),
      getStreamResponse(jobId),
      getStreamSteps(jobId),
    ]);

    if (!jobStatus) {
      return res.status(404).json({ error: 'Job not found' });
    }
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
    if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId))
      return res.status(400).json({ error: 'Invalid job ID' });
    const cancellation = await cancelChatJob(session.username, jobId);
    if (cancellation.outcome === 'missing' && submissionId)
      return res.status(200).json({ success: true, canceled: true });
    if (cancellation.outcome !== 'cancelled') {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.status(200).json({
      success: true,
      canceled: cancellation.canceled,
      ...(submissionId ? { status: cancellation.previousStatus } : {}),
    });
  } catch (error) {
    logger.error('Error canceling job', error);
    return res.status(500).json({ error: 'Failed to cancel job' });
  }
}
