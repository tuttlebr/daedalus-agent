import {
  extractAsyncStreamContentDelta,
  parseIntermediateDataLine,
} from '@/utils/app/asyncStepParser';
import { buildBackendUrlFromBase } from '@/utils/app/backendApi';
import { stripReplayedAssistantPrefix } from '@/utils/app/conversationReplay';
import { Logger } from '@/utils/logger';

import { getNatBaseUrl } from './backendSelection';
import {
  JOB_EXPIRY_SECONDS,
  STREAM_STATUS_FLUSH_INTERVAL_MS,
  STREAM_STEPS_FLUSH_INTERVAL_MS,
} from './constants';
import {
  DEBUG_REPLAY_ENABLED,
  debugReplayHash,
  debugReplayLog,
} from './debugReplay';
import { finalizeError, finalizeSuccess } from './finalization';
import { abortKey, clearOAuthStatusFields, updateJobStatus } from './jobState';
import { buildNatRequestHeaders } from './natMessages';
import type { AsyncJobRequest, AsyncJobStatus } from './types';

import {
  getPublisher,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';

const logger = new Logger('AsyncJob');

function extractOAuthRequiredPayload(
  eventName: string | null,
  parsed: any,
): { authUrl: string; oauthState?: string } | null {
  const eventType = parsed?.event_type || parsed?.type || parsed?.event;
  const isOAuthEvent =
    eventName === 'oauth_required' || eventType === 'oauth_required';
  const authUrl =
    parsed?.auth_url || parsed?.authUrl || parsed?.authorization_url;
  if (!isOAuthEvent || typeof authUrl !== 'string' || !authUrl) {
    return null;
  }

  const oauthState = parsed?.oauth_state || parsed?.oauthState || parsed?.state;
  return {
    authUrl,
    ...(typeof oauthState === 'string' && oauthState ? { oauthState } : {}),
  };
}

/**
 * Open a streaming connection to the backend's interactive OpenAI-compatible
 * endpoint to capture intermediate steps, OAuth prompts, and content tokens.
 *
 * Runs fire-and-forget after the POST handler returns the jobId.  The
 * accumulated steps are stored in Redis so that handleGet() and
 * finalizeSuccess() can include them.
 */
export async function startBackgroundStreamReader(
  jobId: string,
  jobRequest: AsyncJobRequest,
  messagesForNat: any[],
  verifiedUsername: string,
): Promise<void> {
  const streamUrl = buildBackendUrlFromBase(
    getNatBaseUrl(jobRequest),
    '/v1/chat/completions',
  );
  // NOTE: model / collection_name / max_tokens / top_k are OpenAPI
  // placeholder values. The backend NAT agent owns model and generation config
  // and ignores these; they exist only to satisfy the request schema. Do not
  // rely on them to control generation (F-024).
  const payload = {
    messages: messagesForNat,
    model: 'string',
    max_tokens: 0,
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
    logger.info(
      `Job ${jobId}: Starting background stream reader at ${streamUrl}`,
    );

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
      logger.error(
        `Job ${jobId}: Stream reader got ${response.status}, aborting`,
      );
      await finalizeError(
        jobId,
        jobRequest,
        `Backend stream returned ${response.status}${
          errorText ? ` - ${errorText}` : ''
        }`,
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
      if (!force && now - lastStepsFlushMs < STREAM_STEPS_FLUSH_INTERVAL_MS)
        return;
      lastStepsFlushMs = now;
      await jsonSetWithExpiry(stepsKey, accumulatedSteps, JOB_EXPIRY_SECONDS);
    };

    const flushStreamingStatus = async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastStatusFlushMs < STREAM_STATUS_FLUSH_INTERVAL_MS)
        return;
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
          logger.info(
            `Job ${jobId}: Stream reader received abort signal — job finalized, stopping`,
          );
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
              publisher
                .publish(
                  tokenChannel,
                  JSON.stringify({
                    type: 'chat_intermediate_step',
                    conversationId,
                    jobId,
                    turnId: jobRequest.turnId,
                    assistantMessageId: jobRequest.assistantMessageId,
                    step,
                  }),
                )
                .catch(() => {});
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
            const oauthPayload = extractOAuthRequiredPayload(
              currentSseEvent,
              parsed,
            );
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
            const content = extractAsyncStreamContentDelta(
              parsed,
              partialResponse,
            );
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
                publisher
                  .publish(
                    tokenChannel,
                    JSON.stringify({
                      type: 'chat_token',
                      conversationId,
                      jobId,
                      turnId: jobRequest.turnId,
                      assistantMessageId: jobRequest.assistantMessageId,
                      content,
                    }),
                  )
                  .catch(() => {});
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
    const currentStatus = (await jsonGet(
      sessionKey(['async-job-status', jobId]),
    )) as AsyncJobStatus | null;
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
      logger.info(
        `Job ${jobId}: Stream reader aborted cleanly (job finalized)`,
      );
    } else {
      logger.error(`Job ${jobId}: Stream reader error: ${err.message}`);
      await finalizeError(
        jobId,
        jobRequest,
        err.message || 'Backend stream reader failed',
      ).catch((finalizeErr) => {
        logger.error(
          `Job ${jobId}: Failed to finalize stream reader error`,
          finalizeErr,
        );
      });
    }
    // Persist whatever we have so far (steps may still be useful)
    if (accumulatedSteps.length > 0) {
      await jsonSetWithExpiry(
        stepsKey,
        accumulatedSteps,
        JOB_EXPIRY_SECONDS,
      ).catch(() => {});
    }
  }
}
