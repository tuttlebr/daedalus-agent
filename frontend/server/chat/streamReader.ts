import {
  extractAsyncStreamContentDelta,
  parseIntermediateDataLine,
} from '@/utils/app/asyncStepParser';
import { buildBackendUrlFromBase } from '@/utils/app/backendApi';
import { stripReplayedAssistantPrefix } from '@/utils/app/conversationReplay';
import { Logger } from '@/utils/logger';

import { getNatBaseUrl } from './backendSelection';
import {
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
import { clearOAuthStatusFields, updateJobStatus } from './jobState';
import { buildNatRequestHeaders } from './natMessages';
import {
  appendStreamResponseDelta,
  appendStreamSteps,
  clearStreamState,
} from './streamState';
import type {
  AsyncJobRequest,
  AsyncJobStatus,
  BackgroundExecutionControl,
  OAuthRequest,
} from './types';

import { getPublisher, jsonGet, sessionKey } from '@/server/session/redis';

const logger = new Logger('AsyncJob');

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
 * Runs inside the dedicated stream worker after it owns the queue entry and
 * lease. Response deltas and steps are appended to normalized Redis keys so
 * polling and finalization can assemble them without rewriting their history.
 */
export async function startBackgroundStreamReader(
  jobId: string,
  jobRequest: AsyncJobRequest,
  messagesForNat: any[],
  verifiedUsername: string,
  control: BackgroundExecutionControl = {},
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
  const statusKey = sessionKey(['async-job-status', jobId]);
  let accumulatedStepCount = 0;
  let pendingSteps: any[] = [];
  let partialResponse = '';
  let pendingResponseDelta = '';
  let lastToolOutput = '';
  let streamDone = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const abortController = new AbortController();
  const handleExternalAbort = () => {
    if (!abortController.signal.aborted) {
      abortController.abort(control.signal?.reason);
    }
  };
  if (control.signal) {
    if (control.signal.aborted) {
      handleExternalAbort();
    } else {
      control.signal.addEventListener('abort', handleExternalAbort, {
        once: true,
      });
    }
  }

  const persistPendingState = async (): Promise<void> => {
    const responseDelta = pendingResponseDelta;
    const steps = pendingSteps;
    pendingResponseDelta = '';
    pendingSteps = [];
    try {
      await Promise.all([
        appendStreamResponseDelta(jobId, responseDelta),
        appendStreamSteps(jobId, steps),
      ]);
    } catch (error) {
      pendingResponseDelta = responseDelta + pendingResponseDelta;
      pendingSteps = [...steps, ...pendingSteps];
      throw error;
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

    if (abortController.signal.aborted) {
      throw abortReason(abortController.signal);
    }
    await control.beforeBackendRequest?.();
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
    let lastResponseFlushMs = 0;
    let lastStepsFlushMs = 0;
    let debugDeltaCounter = 0;

    const flushResponse = async (force = false): Promise<void> => {
      if (!pendingResponseDelta) return;
      const now = Date.now();
      if (
        !force &&
        now - lastResponseFlushMs < STREAM_STATUS_FLUSH_INTERVAL_MS
      ) {
        return;
      }
      lastResponseFlushMs = now;
      const delta = pendingResponseDelta;
      pendingResponseDelta = '';
      try {
        await appendStreamResponseDelta(jobId, delta);
      } catch (error) {
        pendingResponseDelta = delta + pendingResponseDelta;
        throw error;
      }
    };

    const flushSteps = async (force = false): Promise<void> => {
      if (pendingSteps.length === 0) return;
      const now = Date.now();
      if (!force && now - lastStepsFlushMs < STREAM_STEPS_FLUSH_INTERVAL_MS)
        return;
      lastStepsFlushMs = now;
      const steps = pendingSteps;
      pendingSteps = [];
      try {
        await appendStreamSteps(jobId, steps);
      } catch (error) {
        pendingSteps = [...steps, ...pendingSteps];
        throw error;
      }
    };

    const flushStreamingStatus = async (force = false): Promise<void> => {
      await flushResponse(force);
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

            accumulatedStepCount += 1;
            pendingSteps.push(step);
            // Append only new events so live polling doesn't rewrite history.
            await flushSteps();
            await flushStreamingStatus();

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
              await flushResponse(true);
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
              pendingResponseDelta += content;
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
    // contain prior assistant text. Raw entries in the normalized step list are
    // left untouched so the steps panel still shows the true tool data.
    if (!partialResponse.trim() && lastToolOutput) {
      partialResponse = stripReplayedAssistantPrefix(
        lastToolOutput,
        jobRequest.messages || [],
      );
      pendingResponseDelta += partialResponse;
    }

    // Flush only the final unpersisted deltas before taking the terminal
    // snapshot. Each normalized key keeps its own bounded TTL.
    await Promise.all([flushResponse(true), flushSteps(true)]);
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
        stepsCount: accumulatedStepCount,
      });
    }

    await finalizeSuccess(jobId, jobRequest, partialResponse);

    logger.info(`Job ${jobId}: Stream reader finished`, {
      steps: accumulatedStepCount,
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
      if (control.signal?.aborted) {
        const currentStatus = (await jsonGet(
          statusKey,
        )) as AsyncJobStatus | null;
        if (
          currentStatus?.finalizedAt ||
          currentStatus?.status === 'completed' ||
          currentStatus?.status === 'error'
        ) {
          pendingResponseDelta = '';
          pendingSteps = [];
          await clearStreamState(jobId).catch(() => {});
        } else {
          await persistPendingState().catch(() => {});
        }
        throw abortReason(control.signal);
      }
    } else {
      logger.error(`Job ${jobId}: Stream reader error: ${err.message}`);
      if (!partialResponse.trim() && lastToolOutput) {
        partialResponse = stripReplayedAssistantPrefix(
          lastToolOutput,
          jobRequest.messages || [],
        );
        pendingResponseDelta += partialResponse;
      }
      await persistPendingState().catch(() => {});
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
    control.signal?.removeEventListener('abort', handleExternalAbort);
    if (!abortController.signal.aborted) {
      abortController.abort();
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
