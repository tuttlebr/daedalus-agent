import type { NextApiRequest, NextApiResponse } from 'next';
import { getPublisher, sessionKey, jsonGet, jsonSetWithExpiry, jsonDel, setStreamingState, clearStreamingState } from '../session/redis';
import { publishStreamingState, publishConversationUpdate } from '@/utils/sync/publish';
import { v4 as uuidv4 } from 'uuid';
import { Message } from '@/types/chat';
import { Logger } from '@/utils/logger';
import { buildAsyncJobSubmitUrl, buildAsyncJobStatusUrl } from '@/utils/app/backendApi';

const logger = new Logger('AsyncJob');

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '150mb',  // Support large document processing payloads
    },
  },
  maxDuration: 900, // 15 minutes
};

interface AsyncJobRequest {
  jobId: string;
  messages: any[];
  additionalProps: any;
  userId: string;
  conversationId?: string;
  conversationName?: string;
  useDeepThinker: boolean;
}

interface AsyncJobStatus {
  jobId: string;
  status: 'pending' | 'streaming' | 'completed' | 'error';
  partialResponse?: string;
  fullResponse?: string;
  intermediateSteps?: any[];
  error?: string;
  progress?: number;
  createdAt: number;
  updatedAt: number;
  conversationId?: string;
  finalizedAt?: number;
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

const JOB_EXPIRY_SECONDS = 60 * 60; // 1 hour
const NAT_ASYNC_EXPIRY_SECONDS = 3600;
const NAT_SYNC_TIMEOUT = 0; // Pure async -- return job_id immediately

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

// ── POST: Submit a new async job to NAT ──────────────────────────────

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { messages, additionalProps, userId, conversationId, conversationName } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages' });
    }

    const jobId = uuidv4();
    const useDeepThinker = additionalProps?.useDeepThinker || false;

    // Process messages: add image references to content for agent context
    const processedMessages = await Promise.all((messages || []).map(async (message: any) => {
      const cleanedMessage = { ...message };

      if (cleanedMessage.attachments && Array.isArray(cleanedMessage.attachments)) {
        const imageAttachments = cleanedMessage.attachments.filter((att: any) => att.type === 'image');
        if (imageAttachments.length > 0) {
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

      return cleanedMessage;
    }));

    // Strip system messages -- the backend's NAT agent owns the system prompt
    const messagesForNat = processedMessages.filter((m: any) => m.role !== 'system');

    // Submit to NAT async endpoint
    const submitUrl = buildAsyncJobSubmitUrl(useDeepThinker);
    const natPayload = {
      messages: messagesForNat,
      job_id: jobId,
      sync_timeout: NAT_SYNC_TIMEOUT,
      expiry_seconds: NAT_ASYNC_EXPIRY_SECONDS,
    };

    logger.info(`Job ${jobId}: Submitting to NAT async at ${submitUrl}`, {
      messageCount: messagesForNat.length,
      useDeepThinker,
    });

    const natResponse = await fetch(submitUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': additionalProps?.username || userId || 'anon',
        'X-Backend-Type': useDeepThinker ? 'deep-thinker' : 'default',
      },
      body: JSON.stringify(natPayload),
    });

    if (!natResponse.ok) {
      const errorText = await natResponse.text();
      logger.error(`Job ${jobId}: NAT async submit failed: ${natResponse.status}`, errorText);
      return res.status(502).json({ error: `Backend error: ${natResponse.status} - ${errorText}` });
    }

    const natResult = await natResponse.json();
    logger.info(`Job ${jobId}: NAT accepted job`, { natStatus: natResult.status });

    // Store job metadata in Redis for the GET handler
    const jobRequest: AsyncJobRequest = {
      jobId,
      messages, // original messages for conversation saving later
      additionalProps,
      userId: userId || 'anon',
      conversationId,
      conversationName,
      useDeepThinker,
    };
    await jsonSetWithExpiry(sessionKey(['async-job-request', jobId]), jobRequest, JOB_EXPIRY_SECONDS);

    // Initialize job status
    const jobStatus: AsyncJobStatus = {
      jobId,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      conversationId,
    };
    await jsonSetWithExpiry(sessionKey(['async-job-status', jobId]), jobStatus, JOB_EXPIRY_SECONDS);

    // Set streaming state for cross-session UI
    const effectiveUserId = userId || 'anon';
    if (conversationId) {
      await setStreamingState(effectiveUserId, conversationId, jobId);
      await publishStreamingState(effectiveUserId, conversationId, true, jobId);
    }

    return res.status(200).json({ jobId, status: 'pending' });
  } catch (error) {
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
    const statusKey = sessionKey(['async-job-status', jobId]);
    const jobStatus = await jsonGet(statusKey) as AsyncJobStatus | null;

    if (!jobStatus) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // If already finalized, return cached status immediately
    if ((jobStatus.status === 'completed' || jobStatus.status === 'error') && jobStatus.finalizedAt) {
      return res.status(200).json(jobStatus);
    }

    // Fetch live status from NAT
    const jobRequest = await jsonGet(sessionKey(['async-job-request', jobId])) as AsyncJobRequest | null;
    if (!jobRequest) {
      return res.status(200).json(jobStatus);
    }

    const natStatusUrl = buildAsyncJobStatusUrl(jobRequest.useDeepThinker, jobId);
    let natStatus: NatAsyncJobResponse;

    try {
      const natResponse = await fetch(natStatusUrl, {
        headers: {
          'X-Backend-Type': jobRequest.useDeepThinker ? 'deep-thinker' : 'default',
        },
      });

      if (!natResponse.ok) {
        if (natResponse.status === 404) {
          await finalizeError(jobId, jobRequest, 'Job not found on backend (may have expired)');
          const updated = await jsonGet(statusKey);
          return res.status(200).json(updated);
        }
        throw new Error(`NAT returned ${natResponse.status}`);
      }

      natStatus = await natResponse.json();
    } catch (err) {
      logger.error(`Job ${jobId}: Failed to fetch NAT status`, err);
      // Return cached status on transient error -- polling will retry
      return res.status(200).json(jobStatus);
    }

    const mappedStatus = mapNatStatus(natStatus.status);

    // Still in progress
    if (mappedStatus === 'pending' || mappedStatus === 'streaming') {
      await updateJobStatus(jobId, {
        status: mappedStatus,
        progress: mappedStatus === 'streaming' ? 50 : 0,
        updatedAt: Date.now(),
      });
      const updated = await jsonGet(statusKey);
      return res.status(200).json(updated);
    }

    // Failed or expired
    if (mappedStatus === 'error') {
      await finalizeError(jobId, jobRequest, natStatus.error || 'Backend job failed');
      const updated = await jsonGet(statusKey);
      return res.status(200).json(updated);
    }

    // Success -- finalize (with atomicity guard)
    const freshStatus = await jsonGet(statusKey) as AsyncJobStatus | null;
    if (freshStatus?.status === 'completed' && freshStatus?.finalizedAt) {
      return res.status(200).json(freshStatus);
    }

    const rawOutput = extractNatOutput(natStatus.output);
    logger.info(`Job ${jobId}: NAT job completed, finalizing`, { outputLength: rawOutput.length });

    await finalizeSuccess(jobId, jobRequest, rawOutput);
    const finalStatus = await jsonGet(statusKey);
    return res.status(200).json(finalStatus);
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
    const requestKey = sessionKey(['async-job-request', jobId]);
    const statusKey = sessionKey(['async-job-status', jobId]);
    const jobRequest = await jsonGet(requestKey) as AsyncJobRequest | null;

    // Clear streaming state if we have context
    if (jobRequest?.conversationId && jobRequest?.userId) {
      await clearStreamingState(jobRequest.userId, jobRequest.conversationId).catch(() => {});
      await publishStreamingState(jobRequest.userId, jobRequest.conversationId, false, jobId as string).catch(() => {});
    }

    await Promise.all([jsonDel(requestKey), jsonDel(statusKey)]);

    // NOTE: NAT async does not expose a cancel endpoint.
    // The Dask job runs to completion but its result is ignored since Redis keys are gone.
    // NAT's expiry_seconds ensures backend cleanup.

    return res.status(200).json({ success: true });
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
  const userId = jobRequest.userId || 'anon';

  // Process base64 images in the response
  let processedContent = rawOutput;
  try {
    const { processMarkdownImages } = await import('@/utils/app/imageHandler');
    processedContent = await processMarkdownImages(rawOutput);
    if (processedContent !== rawOutput) {
      logger.info(`Job ${jobId}: Replaced base64 images with Redis references`);
    }
  } catch (error) {
    logger.error(`Job ${jobId}: Failed to process images`, error);
  }

  // Save conversation to Redis
  if (jobRequest.conversationId) {
    try {
      const assistantMessage: Message = {
        id: uuidv4(),
        role: 'assistant',
        content: processedContent,
        intermediateSteps: [],
      };
      const allMessages = [...(jobRequest.messages || []), assistantMessage];
      const conversationData = {
        id: jobRequest.conversationId,
        name: jobRequest.conversationName,
        messages: allMessages,
        updatedAt: Date.now(),
        isPartial: false,
        completedAt: Date.now(),
      };

      const conversationKey = sessionKey(['conversation', jobRequest.conversationId]);
      await jsonSetWithExpiry(conversationKey, conversationData, 60 * 60 * 24 * 7);

      // Update selected conversation if it matches
      const selectedConvKey = sessionKey(['user', userId, 'selectedConversation']);
      const selectedConv = await jsonGet(selectedConvKey) as any;
      if (selectedConv?.id === jobRequest.conversationId) {
        await jsonSetWithExpiry(selectedConvKey, {
          ...selectedConv,
          messages: allMessages,
          name: jobRequest.conversationName,
          updatedAt: Date.now(),
        }, 60 * 60 * 24 * 7);
        logger.info(`Job ${jobId}: Updated selected conversation for user ${userId}`);
      }

      logger.info(`Job ${jobId}: Saved conversation ${jobRequest.conversationId} with ${allMessages.length} messages`);

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
        fullResponse: processedContent,
        intermediateSteps: [],
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
    intermediateSteps: [],
    progress: 100,
    updatedAt: Date.now(),
    finalizedAt: Date.now(),
  });

  logger.info(`Job ${jobId}: Finalized successfully`);

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
  const userId = jobRequest.userId || 'anon';

  if (jobRequest.conversationId) {
    await clearStreamingState(userId, jobRequest.conversationId).catch(() => {});
    await publishStreamingState(userId, jobRequest.conversationId, false, jobId).catch(() => {});
  }

  await updateJobStatus(jobId, {
    status: 'error',
    error: errorMessage,
    updatedAt: Date.now(),
    finalizedAt: Date.now(),
  });

  logger.info(`Job ${jobId}: Finalized with error: ${errorMessage}`);
}

async function updateJobStatus(jobId: string, updates: Partial<AsyncJobStatus>): Promise<void> {
  const statusKey = sessionKey(['async-job-status', jobId]);
  const currentStatus = await jsonGet(statusKey) as AsyncJobStatus | null;

  if (!currentStatus) {
    logger.error('Job status not found for update', jobId);
    return;
  }

  const updatedStatus: AsyncJobStatus = {
    ...currentStatus,
    ...updates,
  };

  await jsonSetWithExpiry(statusKey, updatedStatus, JOB_EXPIRY_SECONDS);

  // Publish status update via Redis Pub/Sub for WebSocket sidecar
  try {
    const publisher = getPublisher();
    await publisher.publish(`job:${jobId}:status`, JSON.stringify(updatedStatus));
  } catch (err) {
    logger.error(`Failed to publish job status for ${jobId}`, err);
  }
}
