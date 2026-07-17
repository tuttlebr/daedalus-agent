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
  STREAM_ABORT_POLL_INTERVAL_MS,
  STREAM_READ_IDLE_TIMEOUT_MS,
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
import type { AsyncJobRequest, AsyncJobStatus, OAuthRequest } from './types';

import {
  getPublisher,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';

const logger = new Logger('AsyncJob');

const activeStreamControllers = new Map<string, AbortController>();

class StreamIdleTimeoutError extends Error {
  constructor() {
    super(
      `Backend response stream was idle for ${Math.round(
        STREAM_READ_IDLE_TIMEOUT_MS / 1000,
      )} seconds`,
    );
    this.name = 'StreamIdleTimeoutError';
  }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Background response stream aborted');
  error.name = 'AbortError';
  return error;
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  abortController: AbortController,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let handleAbort: (() => void) | null = null;

  const abortPromise = new Promise<never>((_, reject) => {
    handleAbort = () => reject(abortReason(abortController.signal));
    if (abortController.signal.aborted) {
      handleAbort();
      return;
    }
    abortController.signal.addEventListener('abort', handleAbort, {
      once: true,
    });
  });

  const idlePromise = new Promise<never>((_, reject) => {
    idleTimer = setTimeout(() => {
      const error = new StreamIdleTimeoutError();
      reject(error);
      if (!abortController.signal.aborted) {
        abortController.abort(error);
      }
    }, STREAM_READ_IDLE_TIMEOUT_MS);
    if (typeof (idleTimer as NodeJS.Timeout).unref === 'function') {
      (idleTimer as NodeJS.Timeout).unref();
    }
  });

  try {
    // Keep exactly one reader.read() pending. An abort or idle timeout exits
    // the stream instead of starting another read against the same reader.
    return await Promise.race([reader.read(), abortPromise, idlePromise]);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (handleAbort) {
      abortController.signal.removeEventListener('abort', handleAbort);
    }
  }
}

export function abortBackgroundStream(jobId: string): boolean {
  const controller = activeStreamControllers.get(jobId);
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  return true;
}

function extractOAuthRequiredPayload(
  eventName: string | null,
  parsed: any,
): OAuthRequest | null {
  const eventType = parsed?.event_type || parsed?.type || parsed?.event;
  const isOAuthEvent =
    eventName === 'oauth_required' || eventType === 'oauth_required';
  const authUrl =
    parsed?.auth_url || parsed?.authUrl || parsed?.authorization_url;
  if (!isOAuthEvent || typeof authUrl !== 'string' || !authUrl) {
    return null;
  }

  const oauthState = parsed?.oauth_state || parsed?.oauthState || parsed?.state;
  const normalizedOauthState =
    typeof oauthState === 'string' && oauthState ? oauthState : undefined;
  return {
    id: oauthRequestId(authUrl, normalizedOauthState),
    authUrl,
    ...(normalizedOauthState ? { oauthState: normalizedOauthState } : {}),
    service: inferOAuthService(authUrl),
  };
}

function oauthRequestId(authUrl: string, oauthState?: string): string {
  return oauthState ? `${oauthState}:${authUrl}` : authUrl;
}

function inferOAuthService(authUrl: string): string {
  let decoded = authUrl;
  try {
    decoded = decodeURIComponent(authUrl);
  } catch {
    decoded = authUrl;
  }
  decoded = decoded.toLowerCase();
  if (decoded.includes('gmail')) return 'Gmail';
  if (decoded.includes('calendar')) return 'Calendar';
  return 'Google';
}

function mergeOAuthRequests(
  status: AsyncJobStatus | null,
  nextRequest: OAuthRequest,
): OAuthRequest[] {
  const existing = Array.isArray(status?.oauthRequests)
    ? status.oauthRequests
    : status?.authUrl
    ? [
        {
          id: oauthRequestId(status.authUrl, status.oauthState),
          authUrl: status.authUrl,
          ...(status.oauthState ? { oauthState: status.oauthState } : {}),
          service: inferOAuthService(status.authUrl),
        },
      ]
    : [];
  const byId = new Map(existing.map((request) => [request.id, request]));
  byId.set(nextRequest.id, nextRequest);
  return Array.from(byId.values());
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
  const payload = {
    messages: messagesForNat,
    stream: true,
    additional_props: {
      ...(jobRequest.additionalProps || {}),
      enableIntermediateSteps: true,
    },
    stream_options: { include_usage: true },
  };

  const userId = jobRequest.userId;
  const conversationId = jobRequest.conversationId;
  const stepsKey = sessionKey(['async-job-steps', jobId]);
  const statusKey = sessionKey(['async-job-status', jobId]);
  const accumulatedSteps: any[] = [];
  let partialResponse = '';
  let lastToolOutput = '';
  let streamDone = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let abortPollTimer: NodeJS.Timeout | null = null;
  let abortCheckInFlight = false;
  let streamActive = true;
  const abortController = new AbortController();

  const previousController = activeStreamControllers.get(jobId);
  if (previousController && !previousController.signal.aborted) {
    previousController.abort();
  }
  activeStreamControllers.set(jobId, abortController);

  const checkForRedisAbort = async (): Promise<void> => {
    if (abortCheckInFlight || !streamActive || abortController.signal.aborted) {
      return;
    }
    abortCheckInFlight = true;
    try {
      const shouldAbort = await jsonGet(abortKey(jobId));
      if (shouldAbort && streamActive && !abortController.signal.aborted) {
        abortController.abort();
      }
    } catch (error) {
      logger.debug(`Job ${jobId}: Failed to check stream abort flag`, error);
    } finally {
      abortCheckInFlight = false;
    }
  };

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

    await checkForRedisAbort();
    if (abortController.signal.aborted) {
      throw abortReason(abortController.signal);
    }
    abortPollTimer = setInterval(() => {
      void checkForRedisAbort();
    }, STREAM_ABORT_POLL_INTERVAL_MS);
    if (typeof abortPollTimer.unref === 'function') abortPollTimer.unref();

    const response = await fetch(streamUrl, {
      method: 'POST',
      headers: buildNatRequestHeaders(
        verifiedUsername,
        { 'Content-Type': 'application/json' },
        jobRequest.natSessionId,
        jobRequest.timezone,
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

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentSseEvent: string | null = null;
    const publisher = getPublisher();
    const tokenChannel = conversationId
      ? `user:${userId}:chat:${conversationId}:tokens`
      : null;

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
      const currentStatus = (await jsonGet(statusKey)) as AsyncJobStatus | null;
      const keepOAuthPrompt =
        currentStatus?.status === 'oauth_required' &&
        !partialResponse.trim() &&
        (Boolean(currentStatus.authUrl) ||
          Boolean(currentStatus.oauthRequests?.length));
      await updateJobStatus(
        jobId,
        {
          status: keepOAuthPrompt ? 'oauth_required' : 'streaming',
          partialResponse,
          ...(keepOAuthPrompt ? {} : clearOAuthStatusFields()),
          updatedAt: now,
        },
        { publish: false },
      );
    };

    while (true) {
      const { done, value } = await readStreamChunk(reader, abortController);
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
              const currentStatus = (await jsonGet(
                statusKey,
              )) as AsyncJobStatus | null;
              const oauthRequests = mergeOAuthRequests(
                currentStatus,
                oauthPayload,
              );
              await updateJobStatus(jobId, {
                status: 'oauth_required',
                authUrl: oauthPayload.authUrl,
                oauthState: oauthPayload.oauthState,
                oauthRequests,
                partialResponse,
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
    const currentStatus = (await jsonGet(statusKey)) as AsyncJobStatus | null;
    if (currentStatus?.status === 'oauth_required' && !partialResponse.trim()) {
      // The OAuth event already persisted and published the complete prompt.
      // Leave it untouched here so stream shutdown does not emit a duplicate
      // status event whose only difference is updatedAt.
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
    const idleTimedOut = err?.name === 'StreamIdleTimeoutError';
    if (
      !idleTimedOut &&
      (err?.name === 'AbortError' || abortController.signal.aborted)
    ) {
      // Cancellation/finalization is handled by the caller that set the abort.
      logger.info(`Job ${jobId}: Stream reader aborted cleanly`);
    } else {
      logger.error(`Job ${jobId}: Stream reader error: ${err.message}`);
      if (!partialResponse.trim() && lastToolOutput) {
        partialResponse = stripReplayedAssistantPrefix(
          lastToolOutput,
          jobRequest.messages || [],
        );
      }
      await jsonSetWithExpiry(
        stepsKey,
        accumulatedSteps,
        JOB_EXPIRY_SECONDS,
      ).catch(() => {});
      await updateJobStatus(
        jobId,
        {
          ...(partialResponse ? { partialResponse } : {}),
          updatedAt: Date.now(),
        },
        { publish: false },
      ).catch(() => {});
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
  } finally {
    streamActive = false;
    if (abortPollTimer) {
      clearInterval(abortPollTimer);
      abortPollTimer = null;
    }
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
    if (activeStreamControllers.get(jobId) === abortController) {
      activeStreamControllers.delete(jobId);
    }
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // The body may already be closed or aborted.
      }
      try {
        reader.releaseLock();
      } catch {
        // The response body may already have released its lock on abort.
      }
    }
  }
}
