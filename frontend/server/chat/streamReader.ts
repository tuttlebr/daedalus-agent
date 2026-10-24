import {
  extractAsyncStreamContentDelta,
  parseIntermediateDataLine,
} from '@/utils/app/asyncStepParser';
import { buildBackendUrlFromBase } from '@/utils/app/backendApi';
import { inferGoogleWorkspaceService } from '@/utils/app/googleWorkspace';
import {
  extractMcpApprovalMarkerText,
  parseMcpApprovalMarker,
} from '@/utils/app/mcpApproval';
import { Logger } from '@/utils/logger';

import { getNatBaseUrl } from './backendSelection';
import {
  MCP_OAUTH_STREAM_IDLE_TIMEOUT_MS,
  STREAM_CONNECT_TIMEOUT_MS,
  STREAM_READ_IDLE_TIMEOUT_MS,
  STREAM_STATUS_FLUSH_INTERVAL_MS,
  STREAM_STEPS_FLUSH_INTERVAL_MS,
  STREAM_TOKEN_PUBLISH_INTERVAL_MS,
  JOB_EXPIRY_SECONDS,
} from './constants';
import {
  DEBUG_REPLAY_ENABLED,
  debugReplayHash,
  debugReplayLog,
} from './debugReplay';
import { finalizeError, finalizeSuccess } from './finalization';
import {
  abortKey,
  isTerminalStatusRecord,
  markJobStreaming,
  recordOAuthJobRequest,
} from './jobState';
import { validateModelProfile } from './modelProfile';
import { buildNatRequestHeaders } from './natMessages';
import { sanitizeSandboxArtifactStep } from './sandboxArtifacts';
import {
  appendStreamResponseDelta,
  appendStreamSteps,
  clearStreamState,
} from './streamState';
import {
  ApiRouteError,
  type AsyncJobRequest,
  type AsyncJobStatus,
  type BackgroundExecutionControl,
  type OAuthRequest,
  PublicJobError,
  StreamUserCancellationError,
  USER_CANCELLATION_MESSAGE,
} from './types';

import { saveOAuthCallbackTarget } from '@/server/mcpOAuth';
import {
  getPublisher,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';

const logger = new Logger('AsyncJob');

class StreamIdleTimeoutError extends PublicJobError {
  constructor(timeoutMs: number) {
    super(
      `Backend response stream was idle for ${Math.round(
        timeoutMs / 1000,
      )} seconds`,
    );
    this.name = 'StreamIdleTimeoutError';
  }
}

const STREAM_INTERNAL_FAILURE_MESSAGE =
  'The response could not be completed because of an internal error. Please try again.';
const BACKEND_UNREACHABLE_MESSAGE =
  'The response service could not be reached. Please try again.';

/**
 * Run outcomes the Rust backend reports as `{"error":{"message":...}}` in its
 * terminal error event (builder/runtime/src/main.rs). They are written for
 * users; any other error text may be a provider, proxy or validation
 * diagnostic and is logged instead of saved.
 */
const PUBLIC_BACKEND_RUN_ERRORS = new Set([
  'Run cancelled by user',
  'Agent run timed out',
  'Agent iteration limit reached',
  'Repeated identical tool failure',
  'Invalid or repeated tool call ID; the rejected batch was not executed',
  'Required tool did not complete successfully; no answer was accepted',
  'Model response did not complete',
  'Model request timed out',
  'Client disconnected',
  'Model response could not be decoded; completed output has been preserved',
  'Model stream interrupted after retry limit; completed output has been preserved',
  'Agent execution failed; completed output has been preserved',
]);

function publicStreamErrorMessage(jobId: string, error: unknown): string {
  if (error instanceof PublicJobError || error instanceof ApiRouteError) {
    return error.message;
  }
  logger.error(`Job ${jobId}: Stream reader failed`, error);
  return STREAM_INTERNAL_FAILURE_MESSAGE;
}

/**
 * Saved chat error for a rejected backend request. The backend's per-process
 * admission can still refuse a job the shared Redis admission accepted; say
 * what to do instead of exposing a bare status. Bodies are never read here.
 */
export function backendRejectionMessage(status: number): string {
  if (status === 409) {
    return 'Another response is already active for this conversation. Wait for it to finish or stop it, then try again.';
  }
  if (status === 429) {
    return 'Too many responses are running right now. Wait for one to finish or stop a response, then try again.';
  }
  return `Backend stream returned ${status}`;
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
  idleTimeoutMs = STREAM_READ_IDLE_TIMEOUT_MS,
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
      const error = new StreamIdleTimeoutError(idleTimeoutMs);
      reject(error);
      if (!abortController.signal.aborted) {
        abortController.abort(error);
      }
    }, idleTimeoutMs);
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
    service: inferGoogleWorkspaceService(authUrl),
  };
}

function oauthRequestId(authUrl: string, oauthState?: string): string {
  return oauthState ? `${oauthState}:${authUrl}` : authUrl;
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
  const profileError = validateModelProfile(jobRequest.additionalProps);
  if (profileError)
    throw new ApiRouteError(400, profileError, 'invalid_model_profile');
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
  const tokenChannel = conversationId
    ? `user:${userId}:chat:${conversationId}:tokens`
    : null;
  // Contiguous token deltas within one publish interval share a message. The
  // first delta after a quiet interval goes out at once, so time to first
  // token is unchanged; each message carries its first character's offset.
  // Every other event on the token channel flushes the buffer first, keeping
  // tokens and steps in their original order.
  let pendingToken: { content: string; responseStart: number } | null = null;
  let lastTokenPublishAt = 0;
  let tokenFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushTokens = (): void => {
    if (tokenFlushTimer) {
      clearTimeout(tokenFlushTimer);
      tokenFlushTimer = null;
    }
    const token = pendingToken;
    pendingToken = null;
    if (!token || !tokenChannel) return;
    lastTokenPublishAt = Date.now();
    getPublisher()
      .publish(
        tokenChannel,
        JSON.stringify({
          type: 'chat_token',
          conversationId,
          jobId,
          turnId: jobRequest.turnId,
          assistantMessageId: jobRequest.assistantMessageId,
          content: token.content,
          responseStart: token.responseStart,
        }),
      )
      .catch(() => {});
  };
  const publishToken = (content: string, responseStart: number): void => {
    if (!tokenChannel) return;
    if (pendingToken) pendingToken.content += content;
    else pendingToken = { content, responseStart };
    const wait =
      lastTokenPublishAt + STREAM_TOKEN_PUBLISH_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      flushTokens();
    } else if (!tokenFlushTimer) {
      tokenFlushTimer = setTimeout(flushTokens, wait);
      tokenFlushTimer.unref?.();
    }
  };
  let accumulatedStepCount = 0;
  // Every step published in this run, in order. Finalization reads the
  // persisted list back from Redis; this copy fills in if that key was lost.
  const observedSteps: any[] = [];
  let pendingSteps: any[] = [];
  let partialResponse = '';
  let pendingResponseDelta = '';
  let persistedResponseBytes = 0;
  let persistedStepCount = 0;
  let pendingApprovalMarker: string | null = null;
  let streamDone = false;
  // Once this backend stream has requested interactive authorization, keep its
  // longer idle budget for the rest of the turn. Parallel Google tool calls
  // continue to emit intermediate steps and content while another service is
  // still waiting for its browser callback; those sibling events must not
  // silently restore the ordinary five-minute deadline.
  let oauthPromptSeen = false;
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

  const persistResponse = async (): Promise<void> => {
    const delta = pendingResponseDelta;
    pendingResponseDelta = '';
    try {
      await appendStreamResponseDelta(jobId, delta, persistedResponseBytes);
      persistedResponseBytes += Buffer.byteLength(delta, 'utf8');
    } catch (error) {
      pendingResponseDelta = delta + pendingResponseDelta;
      throw error;
    }
  };
  const persistSteps = async (): Promise<void> => {
    const steps = pendingSteps;
    pendingSteps = [];
    try {
      await appendStreamSteps(jobId, steps, persistedStepCount);
      persistedStepCount += steps.length;
    } catch (error) {
      pendingSteps = [...steps, ...pendingSteps];
      throw error;
    }
  };
  const persistPendingState = async (): Promise<void> => {
    // Settle both before retry/finalization so the sibling write cannot still
    // be in flight while its buffer and acknowledged offset are reused.
    const results = await Promise.allSettled([
      persistResponse(),
      persistSteps(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
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
    // This await resolves when response headers arrive; body reads are
    // guarded separately by the idle timeout. Bound the header wait so a
    // wedged backend fails the job with a clear error instead of holding the
    // worker slot open at the OS socket default.
    const connectTimer = setTimeout(() => {
      abortController.abort(
        new PublicJobError(
          `Backend did not return response headers within ${STREAM_CONNECT_TIMEOUT_MS}ms`,
        ),
      );
    }, STREAM_CONNECT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(streamUrl, {
        method: 'POST',
        headers: buildNatRequestHeaders(
          verifiedUsername,
          { 'Content-Type': 'application/json' },
          jobRequest.natSessionId,
          jobRequest.timezone,
          jobRequest.conversationId,
          jobId,
        ),
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });
    } catch (error) {
      if (abortController.signal.aborted) throw error;
      // Network failures name pod addresses; keep those in the log.
      logger.error(`Job ${jobId}: Backend request failed`, error);
      throw new PublicJobError(BACKEND_UNREACHABLE_MESSAGE);
    } finally {
      clearTimeout(connectTimer);
    }

    reader = response.body?.getReader() ?? null;
    if (!response.ok || !reader) {
      // Status is enough to report a failed HTTP request. Reading an error
      // body here bypasses the stream's idle deadline and can hold a worker
      // forever; it can also expose backend diagnostics in saved chat errors.
      // The finally block aborts/cancels this body without consuming it.
      logger.error(
        `Job ${jobId}: Stream reader got ${response.status}, aborting`,
      );
      await finalizeError(
        jobId,
        jobRequest,
        backendRejectionMessage(response.status),
      );
      return;
    }

    // Successful response headers establish backend acceptance. Preparation
    // and hidden reasoning can be silent, so waiting for a body chunk leaves
    // an executing job labelled Queued. Publish this transition once, before
    // reading the body; the worker already fenced backend execution in Redis.
    await markJobStreaming(jobId, Date.now());

    const decoder = new TextDecoder();
    let buffer = '';
    let skipLeadingLineFeed = false;
    let currentSseEvent: string | null = null;
    const publisher = getPublisher();

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
      await persistResponse();
    };

    const flushSteps = async (force = false): Promise<void> => {
      if (pendingSteps.length === 0) return;
      const now = Date.now();
      if (!force && now - lastStepsFlushMs < STREAM_STEPS_FLUSH_INTERVAL_MS)
        return;
      lastStepsFlushMs = now;
      await persistSteps();
    };

    while (true) {
      const { done, value } = await readStreamChunk(
        reader,
        abortController,
        oauthPromptSeen
          ? MCP_OAUTH_STREAM_IDLE_TIMEOUT_MS
          : STREAM_READ_IDLE_TIMEOUT_MS,
      );
      if (done) break;

      let chunk = decoder.decode(value, { stream: true });
      if (chunk) {
        // CR terminates a line immediately. If its optional LF arrives in a
        // later transport chunk, consume it without manufacturing a blank
        // event boundary. Empty UTF-8 decoder output must preserve this state.
        if (skipLeadingLineFeed && chunk.startsWith('\n')) {
          chunk = chunk.slice(1);
        }
        skipLeadingLineFeed = chunk.endsWith('\r');
        buffer += chunk.replace(/\r\n?/g, '\n');
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line === '') {
          currentSseEvent = null;
          continue;
        }

        // SSE permits one optional space after the first colon; field names
        // remain case-sensitive. NAT's intermediate_data extension follows
        // the same line framing as the standard event/data fields.
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const fieldValue =
          colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') {
          currentSseEvent = fieldValue;
          continue;
        }

        // ── intermediate_data: lines → parse step, store, publish ──
        if (field === 'intermediate_data') {
          const step = parseIntermediateDataLine(fieldValue);
          if (step) {
            // Step outputs are recorded verbatim; only private sandbox
            // artifact markers are removed before persistence/publication.
            sanitizeSandboxArtifactStep(step);

            accumulatedStepCount += 1;
            observedSteps.push(step);
            pendingSteps.push(step);
            // Append only new events so live polling doesn't rewrite history.
            await flushSteps();
            await flushResponse();

            if (tokenChannel) {
              flushTokens();
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
          }
        }

        // ── data: lines → extract content tokens ──
        if (field === 'data') {
          const data = fieldValue.trim();
          if (data === '[DONE]') {
            streamDone = true;
            break;
          }
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            // Non-JSON data line — skip. Processing and persistence failures
            // must escape this block so the job fails instead of hanging.
            continue;
          }
          if (currentSseEvent === 'steering') {
            const commandId = parsed?.command_id;
            const status = parsed?.status;
            if (
              typeof commandId !== 'string' ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                commandId,
              ) ||
              !['received', 'applied', 'cancelled'].includes(status)
            ) {
              throw new PublicJobError(
                'Backend sent an invalid steering event',
              );
            }
            const existing = jobRequest.messages.find(
              (message: any) =>
                message?.metadata?.steeringCommandId === commandId,
            );
            if (status === 'received') {
              if (
                typeof parsed.instruction !== 'string' ||
                new TextEncoder().encode(parsed.instruction).length > 16_000
              ) {
                throw new PublicJobError('Backend sent an invalid direction');
              }
              if (!existing)
                jobRequest.messages.push({
                  id: commandId,
                  role: 'user',
                  content: parsed.instruction,
                  metadata: {
                    steeringCommandId: commandId,
                    steeringStatus: status,
                    jobId,
                  },
                });
            } else if (existing) {
              existing.metadata.steeringStatus = status;
            }
            await jsonSetWithExpiry(
              sessionKey(['async-job-request', jobId]),
              jobRequest,
              JOB_EXPIRY_SECONDS,
            );
            if (tokenChannel) {
              flushTokens();
              await publisher.publish(
                tokenChannel,
                JSON.stringify({
                  type: 'steering_status',
                  jobId,
                  conversationId,
                  commandId,
                  status,
                  assistantMessageId: jobRequest.assistantMessageId,
                  instruction: parsed.instruction || existing?.content,
                }),
              );
            }
            continue;
          }
          if (currentSseEvent === 'mcp_approval_required') {
            const marker = extractMcpApprovalMarkerText(parsed?.marker);
            if (!marker || !parseMcpApprovalMarker(marker)) {
              throw new PublicJobError(
                'Backend sent an invalid MCP approval event',
              );
            }
            pendingApprovalMarker = marker;
            streamDone = true;
            break;
          }
          const oauthPayload = extractOAuthRequiredPayload(
            currentSseEvent,
            parsed,
          );
          if (oauthPayload) {
            try {
              await flushResponse(true);
              if (oauthPayload.oauthState) {
                await saveOAuthCallbackTarget(
                  oauthPayload.oauthState,
                  getNatBaseUrl(jobRequest),
                  jobId,
                  jobRequest.userId,
                );
              }
              // The atomic write is the persistence receipt. A callback may
              // consume the prompt immediately after it commits; rereading it
              // here would misclassify that successful authorization as failure.
              if (!(await recordOAuthJobRequest(jobId, oauthPayload))) {
                throw new Error('OAuth prompt status was not persisted');
              }
            } catch (error) {
              logger.error(
                `Job ${jobId}: Failed to persist OAuth authorization prompt`,
                error,
              );
              throw new PublicJobError(
                'Authentication prompt could not be delivered',
              );
            }
            oauthPromptSeen = true;
            logger.info(`Job ${jobId}: OAuth authorization prompt persisted`, {
              service: oauthPayload.service,
            });
            continue;
          }
          if (
            parsed.error ||
            currentSseEvent === 'error' ||
            parsed?.choices?.[0]?.finish_reason === 'error'
          ) {
            const backendMessage =
              typeof parsed.error === 'string'
                ? parsed.error.trim()
                : typeof parsed.error?.message === 'string'
                ? parsed.error.message.trim()
                : typeof parsed.message === 'string'
                ? parsed.message.trim()
                : '';
            if (PUBLIC_BACKEND_RUN_ERRORS.has(backendMessage)) {
              throw new PublicJobError(
                `Backend stream failed: ${backendMessage}`,
              );
            }
            if (backendMessage) {
              logger.error(`Job ${jobId}: Backend stream error event`, {
                message: backendMessage.slice(0, 2000),
              });
            }
            throw new PublicJobError('Backend stream reported an error');
          }
          const content = extractAsyncStreamContentDelta(
            parsed,
            partialResponse,
          );
          if (content && typeof content === 'string') {
            const responseStart = partialResponse.length;
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
            // Publish content for real-time streaming in the PWA.
            publishToken(content, responseStart);
            await flushResponse();
          }

          // The Responses adapter emits a Daedalus-only terminal marker when
          // the provider completes the final-answer item, before NAT tracing
          // and exporter teardown. Other backends use the standard OpenAI
          // finish_reason terminal. Neither path needs to wait for [DONE] or
          // transport EOF while teardown keeps the connection open.
          const finishReason = parsed?.choices?.[0]?.finish_reason;
          const daedalusTerminal =
            parsed?.choices?.[0]?.daedalus_terminal === true;
          if (
            daedalusTerminal ||
            (typeof finishReason === 'string' && finishReason.length > 0)
          ) {
            streamDone = true;
            break;
          }
        }
      }

      if (streamDone) break;
      // Tool calls and hidden reasoning can leave the stream quiet for minutes
      // apart from activity comments. Persist anything the throttle buffered
      // so recovery polling, traces and reclaim see it during that gap. The
      // same 750 ms throttle bounds writes; an empty buffer writes nothing.
      await flushSteps();
      await flushResponse();
    }

    // Transport EOF alone cannot establish that the agent finished. A pod or
    // proxy can close the connection after any token or intermediate tool.
    // That includes a pending OAuth prompt: the backend waits for its callback
    // inside the run, and a closed stream ends that run and its pending state.
    if (!streamDone) {
      throw new PublicJobError(
        'Backend response stream ended before completion',
      );
    }

    // The gate owns the approval prompt. Discard any model prose produced
    // before cancellation and persist only the compact structured marker.
    if (pendingApprovalMarker) {
      partialResponse = pendingApprovalMarker;
      pendingResponseDelta = pendingApprovalMarker;
      pendingToken = null;
    }
    flushTokens();

    // Flush only the final unpersisted deltas before taking the terminal
    // snapshot. Each normalized key keeps its own bounded TTL.
    await persistPendingState();

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

    await finalizeSuccess(jobId, jobRequest, partialResponse, observedSteps);

    logger.info(`Job ${jobId}: Stream reader finished`, {
      steps: accumulatedStepCount,
      partialResponseLength: partialResponse.length,
    });
  } catch (err: any) {
    flushTokens();
    if (control.signal?.aborted) {
      // Only an external abort delegates finalization to the worker. Our own
      // connection/idle deadlines must persist their error and release slots.
      logger.info(`Job ${jobId}: Stream reader aborted cleanly`);
      const currentStatus = (await jsonGet(statusKey)) as AsyncJobStatus | null;
      if (isTerminalStatusRecord(currentStatus)) {
        pendingResponseDelta = '';
        pendingSteps = [];
        await clearStreamState(jobId).catch(() => {});
      } else {
        await persistPendingState().catch(() => {});
        if (control.signal.reason instanceof StreamUserCancellationError) {
          control.signal.reason.snapshot = {
            response: partialResponse,
            pendingSteps,
            persistedStepCount,
          };
        }
      }
      throw abortReason(control.signal);
    } else {
      const error = abortController.signal.aborted
        ? abortReason(abortController.signal)
        : err;
      // The direct backend cancel can close SSE before the worker's Redis
      // polling timer fires. Keep that outcome a user stop, not a backend error.
      const cancelled = Boolean(
        await jsonGet(abortKey(jobId)).catch(() => false),
      );
      if (cancelled)
        logger.info(`Job ${jobId}: Backend acknowledged cancellation`);
      else if (error instanceof PublicJobError)
        logger.error(`Job ${jobId}: Stream reader error: ${error.message}`);
      await persistPendingState().catch(() => {});
      await finalizeError(
        jobId,
        jobRequest,
        cancelled
          ? USER_CANCELLATION_MESSAGE
          : publicStreamErrorMessage(jobId, error),
        {
          response: partialResponse,
          pendingSteps,
          persistedStepCount,
        },
      ).catch((finalizeErr) => {
        logger.error(
          `Job ${jobId}: Failed to finalize stream reader error`,
          finalizeErr,
        );
      });
    }
  } finally {
    if (tokenFlushTimer) clearTimeout(tokenFlushTimer);
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
