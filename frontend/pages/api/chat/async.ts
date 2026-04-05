import type { NextApiRequest, NextApiResponse } from 'next';
import { getPublisher, sessionKey, jsonGet, jsonSetWithExpiry, jsonDel, setStreamingState, clearStreamingState } from '../session/redis';
import { publishStreamingState, publishConversationUpdate } from '@/utils/sync/publish';
import { v4 as uuidv4 } from 'uuid';
import { Message } from '@/types/chat';
import { Logger } from '@/utils/logger';
import { buildAsyncJobSubmitUrl, buildAsyncJobStatusUrl, buildBackendUrlForMode } from '@/utils/app/backendApi';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout';
import { getSession } from '@/utils/auth/session';

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
const NAT_SUBMIT_TIMEOUT_MS = 12_000; // Per-attempt timeout — async submit should return immediately with a job_id
const NAT_SUBMIT_MAX_RETRIES = 3; // Max attempts for NAT submission
const NAT_RETRY_DELAY_MS = 15_000; // Wait between retries — long enough for readiness probe recovery (~30s pod restart)
const NAT_CONNECTIVITY_TIMEOUT_MS = 5_000; // Fast pre-check before sending full payload

// Redis key signalling that a job has been finalized (or is finalizing).
// Set by handleGet before calling finalizeSuccess/finalizeError so the
// background stream reader stops publishing events and status updates.
const abortKey = (jobId: string) => sessionKey(['async-job-abort', jobId]);

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
 * Open a parallel streaming connection to the backend's /chat/stream
 * endpoint to capture intermediate steps and content tokens in real time.
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
  const streamUrl = buildBackendUrlForMode(jobRequest.useDeepThinker, '/chat/stream');
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

  const userId = jobRequest.userId || 'anon';
  const conversationId = jobRequest.conversationId;
  const stepsKey = sessionKey(['async-job-steps', jobId]);
  const accumulatedSteps: any[] = [];
  let partialResponse = '';
  let lastToolOutput = '';

  try {
    logger.info(`Job ${jobId}: Starting background stream reader at ${streamUrl}`);
    const abortController = new AbortController();
    const response = await fetch(streamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': verifiedUsername,
        'X-Backend-Type': jobRequest.useDeepThinker ? 'deep-thinker' : 'default',
      },
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });

    if (!response.ok || !response.body) {
      logger.error(`Job ${jobId}: Stream reader got ${response.status}, aborting`);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const publisher = getPublisher();
    const tokenChannel = conversationId
      ? `user:${userId}:chat:${conversationId}:tokens`
      : null;

    // Rate-limited abort check: at most once per second to avoid Redis overhead.
    // handleGet sets abortKey before calling finalizeSuccess so the parallel
    // stream reader stops publishing events and updating job status.
    let lastAbortCheckMs = 0;

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
        // ── intermediate_data: lines → parse step, store, publish ──
        if (line.startsWith('intermediate_data: ')) {
          const step = parseIntermediateDataLine(
            line.slice('intermediate_data: '.length),
          );
          if (step) {
            accumulatedSteps.push(step);
            // Persist incrementally so handleGet() can return live steps
            await jsonSetWithExpiry(stepsKey, accumulatedSteps, JOB_EXPIRY_SECONDS);

            if (tokenChannel) {
              publisher.publish(tokenChannel, JSON.stringify({
                type: 'chat_intermediate_step',
                conversationId,
                jobId,
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
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) continue;
            const content =
              parsed.choices?.[0]?.delta?.content ??
              parsed.choices?.[0]?.message?.content ??
              parsed.output ??
              parsed.content ??
              '';
            if (content && typeof content === 'string') {
              partialResponse += content;
              // Publish content token for real-time streaming in PWA
              if (tokenChannel) {
                publisher.publish(tokenChannel, JSON.stringify({
                  type: 'chat_token',
                  conversationId,
                  jobId,
                  content,
                })).catch(() => {});
              }
              // Update partial response in job status
              await updateJobStatus(jobId, {
                status: 'streaming',
                partialResponse,
                intermediateSteps: accumulatedSteps,
                updatedAt: Date.now(),
              });
            }
          } catch {
            // Non-JSON data line — skip
          }
        }
      }
    }

    // If stream produced content but NAT async hasn't finished yet, use
    // lastToolOutput as recovery (same logic as chat.ts)
    if (!partialResponse.trim() && lastToolOutput) {
      partialResponse = lastToolOutput;
    }

    // Final persist of all accumulated steps
    await jsonSetWithExpiry(stepsKey, accumulatedSteps, JOB_EXPIRY_SECONDS);
    // Update job status with partial response and steps
    await updateJobStatus(jobId, {
      intermediateSteps: accumulatedSteps,
      ...(partialResponse ? { partialResponse } : {}),
      updatedAt: Date.now(),
    });

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
    }
    // Persist whatever we have so far (steps may still be useful)
    if (accumulatedSteps.length > 0) {
      await jsonSetWithExpiry(stepsKey, accumulatedSteps, JOB_EXPIRY_SECONDS).catch(() => {});
    }
  }
}

// ── POST: Submit a new async job to NAT ──────────────────────────────

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { messages, additionalProps, userId, conversationId, conversationName } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages' });
    }

    // SECURITY: Derive user identity from the server-side session,
    // not from client-sent additionalProps/userId which can be spoofed.
    const session = await getSession(req, res);
    const verifiedUsername = session?.username || 'anon';

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

    // Strip system messages -- the backend's NAT agent owns the system prompt.
    // Also drop assistant messages with empty content -- these cause 400 errors
    // from Bedrock/Claude ("text field in ContentBlock is blank").
    const messagesForNat = processedMessages
      .filter((m: any) => m.role !== 'system')
      .filter((m: any) => {
        if (m.role === 'assistant') {
          const c = typeof m.content === 'string' ? m.content.trim() : m.content;
          return Boolean(c);
        }
        return true;
      });

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

    // Fast connectivity pre-check: HEAD request with short timeout to detect
    // unreachable backends in seconds instead of waiting the full POST timeout.
    // This catches the common case where the backend pod is not ready or the
    // event loop is hung (TCP probe passes but HTTP requests hang).
    try {
      await fetchWithTimeout(submitUrl, { method: 'HEAD' }, NAT_CONNECTIVITY_TIMEOUT_MS);
    } catch (connErr: any) {
      logger.error(`Job ${jobId}: Backend connectivity check failed: ${connErr.message}`);
      return res.status(503).json({
        error: `Backend is not reachable (connectivity check failed after ${NAT_CONNECTIVITY_TIMEOUT_MS}ms). The backend may be starting up or temporarily unavailable.`,
        reason: 'backend_unavailable',
      });
    }

    const natHeaders = {
      'Content-Type': 'application/json',
      'x-user-id': verifiedUsername,
      'X-Backend-Type': useDeepThinker ? 'deep-thinker' : 'default',
    };
    const natBody = JSON.stringify(natPayload);

    let natResult: any;
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= NAT_SUBMIT_MAX_RETRIES; attempt++) {
      try {
        const natResponse = await fetchWithTimeout(submitUrl, {
          method: 'POST',
          headers: natHeaders,
          body: natBody,
        }, NAT_SUBMIT_TIMEOUT_MS);

        if (!natResponse.ok) {
          const errorText = await natResponse.text();
          lastError = `${natResponse.status} - ${errorText}`;
          // Don't retry client errors (4xx)
          if (natResponse.status >= 400 && natResponse.status < 500) {
            logger.error(`Job ${jobId}: NAT async submit rejected (${natResponse.status}), not retrying`, errorText);
            return res.status(502).json({ error: `Backend error: ${lastError}` });
          }
          logger.warn(`Job ${jobId}: NAT async submit failed (attempt ${attempt}/${NAT_SUBMIT_MAX_RETRIES}): ${lastError}`);
        } else {
          natResult = await natResponse.json();
          break;
        }
      } catch (err: any) {
        lastError = err.message || 'Unknown fetch error';
        logger.warn(`Job ${jobId}: NAT async submit error (attempt ${attempt}/${NAT_SUBMIT_MAX_RETRIES}): ${lastError}`);
      }

      if (attempt < NAT_SUBMIT_MAX_RETRIES) {
        logger.info(`Job ${jobId}: Retrying in ${NAT_RETRY_DELAY_MS}ms...`);
        await new Promise((resolve) => setTimeout(resolve, NAT_RETRY_DELAY_MS));
      }
    }

    if (!natResult) {
      logger.error(`Job ${jobId}: NAT async submit failed after ${NAT_SUBMIT_MAX_RETRIES} attempts: ${lastError}`);
      return res.status(502).json({
        error: `Backend unavailable after ${NAT_SUBMIT_MAX_RETRIES} attempts: ${lastError}`,
        reason: 'backend_unavailable',
      });
    }
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

    // Respond immediately so the client can start polling / WS listening
    res.status(200).json({ jobId, status: 'pending' });

    // Fire-and-forget: open a parallel streaming connection to capture
    // intermediate steps and content tokens in real time.  The Node.js
    // runtime keeps the async work alive after res.json() returns.
    startBackgroundStreamReader(
      jobId,
      jobRequest,
      messagesForNat,
      verifiedUsername,
    ).catch((err) => {
      logger.error(`Job ${jobId}: Background stream reader failed`, err);
    });

    return;
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
      const natResponse = await fetchWithTimeout(natStatusUrl, {
        headers: {
          'X-Backend-Type': jobRequest.useDeepThinker ? 'deep-thinker' : 'default',
        },
      }, 30_000);

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

    // Merge live intermediate steps from the background stream reader
    const stepsKey = sessionKey(['async-job-steps', jobId]);
    const liveSteps = await jsonGet(stepsKey) as any[] | null;

    // Still in progress
    if (mappedStatus === 'pending' || mappedStatus === 'streaming') {
      await updateJobStatus(jobId, {
        status: mappedStatus,
        progress: mappedStatus === 'streaming' ? 50 : 0,
        ...(liveSteps?.length ? { intermediateSteps: liveSteps } : {}),
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
    // Check finalizedAt alone: the stream reader can flip status back to
    // 'streaming' (before our guard below kicks in) while keeping finalizedAt,
    // so checking status===completed would cause double-finalization.
    const freshStatus = await jsonGet(statusKey) as AsyncJobStatus | null;
    if (freshStatus?.finalizedAt) {
      return res.status(200).json(freshStatus);
    }

    // Signal the background stream reader to stop BEFORE finalizing.
    // This prevents it from calling updateJobStatus({ status: 'streaming' })
    // after we write { status: 'completed', finalizedAt } below.
    await jsonSetWithExpiry(abortKey(jobId), true, JOB_EXPIRY_SECONDS).catch(() => {});

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

  // Retrieve intermediate steps accumulated by the background stream reader
  const stepsKey = sessionKey(['async-job-steps', jobId]);
  const accumulatedSteps = (await jsonGet(stepsKey) as any[] | null) || [];

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
        content: (processedContent && processedContent.trim()) || '[No response was generated]',
        intermediateSteps: accumulatedSteps,
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

      logger.info(`Job ${jobId}: Saved conversation ${jobRequest.conversationId} with ${allMessages.length} messages (${accumulatedSteps.length} steps)`);

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
    intermediateSteps: accumulatedSteps,
    progress: 100,
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

  const userId = jobRequest.userId || 'anon';

  // Read current job status to preserve any partial progress accumulated during polling
  const statusKey = sessionKey(['async-job-status', jobId]);
  const currentStatus = await jsonGet(statusKey) as AsyncJobStatus | null;
  const partialResponse = currentStatus?.partialResponse || '';

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
        id: uuidv4(),
        role: 'assistant',
        content: (processedContent && processedContent.trim()) || '[Error occurred before response was generated]',
        intermediateSteps,
        errorMessages: {
          message: errorMessage,
          timestamp: Date.now(),
          recoverable: true,
        },
      };
      const allMessages = [...(jobRequest.messages || []), assistantMessage];
      const conversationData = {
        id: jobRequest.conversationId,
        name: jobRequest.conversationName,
        messages: allMessages,
        updatedAt: Date.now(),
        isPartial: true,
        error: errorMessage,
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
    intermediateSteps,
    updatedAt: Date.now(),
    finalizedAt: Date.now(),
  });

  // Clean up steps key
  await jsonDel(stepsKey).catch(() => {});

  logger.info(`Job ${jobId}: Finalized with error: ${errorMessage} (${intermediateSteps.length} steps preserved)`);
}

async function updateJobStatus(jobId: string, updates: Partial<AsyncJobStatus>): Promise<void> {
  const statusKey = sessionKey(['async-job-status', jobId]);
  const currentStatus = await jsonGet(statusKey) as AsyncJobStatus | null;

  if (!currentStatus) {
    logger.error('Job status not found for update', jobId);
    return;
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
