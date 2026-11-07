import type { NextApiRequest, NextApiResponse } from 'next';

import { Logger } from '@/utils/logger';
import { resolveTimezoneFromHeaders } from '@/utils/server/backendAuth';

import { authenticateCompatRequest } from './auth';
import { readJsonBody } from './body';
import { COMPAT_MODEL_ALIAS, isCompatApiEnabled } from './config';
import { CompatError } from './errors';
import {
  type IdempotencyRecord,
  type StoredOutcome,
  claimIdempotencyKey,
  hashCompatRequest,
  releaseIdempotencyKey,
  settleIdempotencyKey,
  validateIdempotencyKey,
} from './idempotency';
import { absolutizeAppLinks, appLink, publicOrigin } from './links';
import { applyOutputBudget } from './outputBudget';
import type { CompatProtocol, NormalizedRequest } from './request';
import {
  type CompatCompletion,
  type CompatResponder,
  type ResponderOptions,
  usageCompleteness,
} from './responders';
import {
  type RunOutcome,
  RunWaitTimeoutError,
  readJobStatus,
  waitForRunOutcome,
} from './runObserver';

import type { ApiKeyPrincipal } from '@/server/apiKeys';
import { cancelChatJob } from '@/server/chat/cancellation';
import {
  INVALID_CONVERSATION_ID_MESSAGE,
  isValidConversationId,
} from '@/server/chat/conversationId';
import { submitChatJob } from '@/server/chat/submission';
import { ApiRouteError } from '@/server/chat/types';
import { checkRateLimit, ruleFromEnv } from '@/server/rateLimit';
import { ConversationWriteError } from '@/server/session/conversationStore';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger('CompatApi');

/** Same bucket as browser chat submissions: one per-user budget. */
const CHAT_SUBMISSION_RATE_LIMIT = ruleFromEnv(
  'chat-async',
  'RATE_LIMIT_CHAT',
  40,
  60,
);

/** Protocol keepalives while a run is quiet; matches the backend cadence. */
export const COMPAT_KEEPALIVE_MS = 15_000;

export const CONVERSATION_HEADER = 'x-daedalus-conversation-id';

export interface CompatRoute {
  protocol: CompatProtocol;
  /** Idempotency scope and metrics label. */
  name: 'chat.completions' | 'messages' | 'responses';
  validateHeaders?: (headers: NextApiRequest['headers']) => void;
  parse: (
    body: unknown,
    headers: NextApiRequest['headers'],
  ) => NormalizedRequest;
  createResponder: (
    res: NextApiResponse,
    options: ResponderOptions,
  ) => CompatResponder;
}

class ClientDisconnectedError extends Error {
  constructor() {
    super('Client disconnected');
    this.name = 'ClientDisconnectedError';
  }
}

function toCompatError(error: unknown, runId?: string): CompatError {
  if (error instanceof CompatError) return error;
  if (error instanceof ConversationWriteError) {
    // Another account's conversation is indistinguishable from a missing one.
    return error.reason === 'conflict'
      ? new CompatError(
          'conflict',
          'The conversation changed or was deleted while submitting. Try again.',
          { code: 'conversation_changed', retryable: true },
        )
      : new CompatError('not_found', 'Conversation not found.', {
          param: 'X-Daedalus-Conversation-ID',
          code: 'conversation_not_found',
        });
  }
  if (error instanceof ApiRouteError) {
    // Every submission failure except an unconfirmed enqueue happened before
    // the job was queued, so nothing ran and a retry is safe.
    switch (error.reason) {
      case 'active_chat_limit':
        return new CompatError('rate_limit', error.message, {
          code: 'active_run_limit',
          retryable: true,
          retryAfterSeconds: 5,
        });
      case 'conversation_job_active':
        return new CompatError('conflict', error.message, {
          code: 'conversation_busy',
          retryable: true,
          retryAfterSeconds: 2,
        });
      case 'submission_unconfirmed':
        return new CompatError(
          'api_error',
          'The run could not be confirmed as started. It may still run; check Daedalus before sending it again.',
          {
            code: 'submission_unconfirmed',
            details: runId ? { runId } : undefined,
          },
        );
      default:
        return new CompatError(
          error.status === 429
            ? 'rate_limit'
            : error.status >= 500
            ? 'overloaded'
            : 'invalid_request',
          error.message,
          { code: error.reason, retryable: error.status >= 429 },
        );
    }
  }
  logger.error('Compatibility request failed before execution', error);
  return new CompatError(
    'api_error',
    'The request could not be started. Try again.',
    { retryable: true },
  );
}

function storedError(error: CompatError): StoredOutcome {
  return {
    kind: 'error',
    error: {
      kind: error.kind,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

function shortTitle(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 60 ? `${line.slice(0, 57)}...` : line || 'API request';
}

const SERVICE_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  drive: 'Google Drive',
  docs: 'Google Docs',
  sheets: 'Google Sheets',
  slides: 'Google Slides',
};

/** Translate a terminal run outcome into an answer or a vendor error. */
async function settleOutcome(
  outcome: RunOutcome,
  context: {
    runId: string;
    principal: ApiKeyPrincipal;
    origin: string | null;
    request: NormalizedRequest;
  },
): Promise<CompatCompletion | CompatError> {
  const { runId, origin } = context;
  switch (outcome.kind) {
    case 'completed': {
      const answer = applyOutputBudget(
        absolutizeAppLinks(outcome.text, origin),
        context.request.maxOutputTokens,
      );
      return { ...answer, ...(outcome.usage ? { usage: outcome.usage } : {}) };
    }
    case 'approval_required': {
      const conversationId = outcome.conversationId;
      const actionUrl = appLink(
        origin,
        conversationId
          ? `/?conversation=${encodeURIComponent(conversationId)}`
          : '/',
      );
      return new CompatError(
        'authorization_required',
        `Daedalus needs your approval before it can continue${
          outcome.summary ? `: ${outcome.summary}` : ''
        }. Nothing was executed for this step. Review it in Daedalus at ${actionUrl}` +
          (conversationId
            ? `, then continue by sending your next message with the header X-Daedalus-Conversation-ID: ${conversationId}`
            : '') +
          `. Run ID: ${runId}.`,
        {
          code: 'approval_required',
          details: {
            runId,
            ...(conversationId ? { conversationId } : {}),
            actionUrl,
            requirement: 'mcp_approval',
          },
        },
      );
    }
    case 'oauth_required': {
      // The sign-in flow belongs to the running process; an API caller cannot
      // complete it, so stop the run and point the user at the web app.
      await cancelChatJob(context.principal.username, runId).catch((error) =>
        logger.warn('Could not stop a run awaiting authorization', {
          runId,
          error,
        }),
      );
      const service =
        (outcome.service && SERVICE_LABELS[outcome.service]) ||
        'a connected service';
      const actionUrl = appLink(origin, '/?view=connections');
      return new CompatError(
        'authorization_required',
        `Daedalus needs you to authorize ${service} before it can use it. ` +
          `This run was stopped and did not complete. Open ${actionUrl}, connect the service from a chat in Daedalus, then retry. Run ID: ${runId}.`,
        {
          code: 'oauth_required',
          details: { runId, actionUrl, requirement: 'oauth' },
        },
      );
    }
    case 'failed':
      return new CompatError(
        'api_error',
        `The Daedalus run failed: ${outcome.message} (run ${runId}).`,
        { code: 'run_failed', details: { runId } },
      );
    case 'cancelled':
      return new CompatError(
        'conflict',
        `The run was stopped before it completed (run ${runId}). Completed actions are not undone.`,
        { code: 'run_cancelled', details: { runId } },
      );
    default:
      return new CompatError(
        'api_error',
        `The outcome of run ${runId} is no longer available.`,
        { code: 'run_unavailable', details: { runId } },
      );
  }
}

interface DeliveryContext {
  req: NextApiRequest;
  res: NextApiResponse;
  responder: CompatResponder;
  principal: ApiKeyPrincipal;
  request: NormalizedRequest;
  route: CompatRoute;
  runId: string;
  startedAt: number;
  mode: 'new' | 'attached';
  idempotency?: { key: string };
}

/**
 * Stream or return one run's outcome. The run is bound to this request: a
 * client that disconnects first stops it through the browser's Stop path,
 * which keeps completed output and never undoes completed actions.
 */
async function deliverRun(context: DeliveryContext): Promise<void> {
  const { res, responder, principal, runId } = context;
  const controller = new AbortController();
  let clientGone = false;
  const onClose = () => {
    if (res.writableEnded) return;
    clientGone = true;
    controller.abort(new ClientDisconnectedError());
  };
  res.on('close', onClose);

  let keepalive: ReturnType<typeof setInterval> | null = null;
  if (responder.streaming) {
    responder.startStream();
    keepalive = setInterval(() => responder.keepalive(), COMPAT_KEEPALIVE_MS);
    keepalive.unref?.();
  }

  let queuedMs: number | null = null;
  let outcome: RunOutcome | null = null;
  let failure: CompatError | null = null;
  try {
    outcome = await waitForRunOutcome(runId, {
      signal: controller.signal,
      onStatus: (status) => {
        if (status !== 'pending' && queuedMs === null) {
          queuedMs = Date.now() - context.startedAt;
        }
      },
    });
  } catch (error) {
    if (!clientGone) {
      failure =
        error instanceof RunWaitTimeoutError
          ? new CompatError(
              'api_error',
              `The run did not finish within the API wait limit and was stopped (run ${runId}).`,
              { code: 'run_timeout', details: { runId } },
            )
          : new CompatError(
              'api_error',
              `The run status could not be read (run ${runId}). It was stopped; completed actions are not undone.`,
              { code: 'run_status_unavailable', details: { runId } },
            );
      if (!(error instanceof RunWaitTimeoutError)) {
        logger.error('Compatibility run status read failed', { runId, error });
      }
    }
    await cancelChatJob(principal.username, runId).catch((cancelError) =>
      logger.warn('Could not stop an abandoned compatibility run', {
        runId,
        error: cancelError,
      }),
    );
  } finally {
    if (keepalive) clearInterval(keepalive);
    res.off('close', onClose);
  }

  const origin = publicOrigin(
    context.req.headers,
    Boolean(
      (context.req.socket as { encrypted?: boolean } | undefined)?.encrypted,
    ),
  );
  const result: CompatCompletion | CompatError = outcome
    ? await settleOutcome(outcome, {
        runId,
        principal,
        origin,
        request: context.request,
      })
    : failure ??
      new CompatError(
        'conflict',
        `The client disconnected; run ${runId} was stopped. Completed actions are not undone.`,
        { code: 'client_disconnected', details: { runId } },
      );

  if (context.idempotency) {
    await settleIdempotencyKey(
      principal.username,
      context.route.name,
      context.idempotency.key,
      runId,
      result instanceof CompatError ? 'failed' : 'completed',
      result instanceof CompatError
        ? storedError(result)
        : {
            kind: 'completed',
            text: result.text,
            truncated: result.truncated,
            ...(result.usage ? { usage: result.usage } : {}),
          },
    ).catch((error) =>
      logger.warn('Could not record an idempotent outcome', { runId, error }),
    );
  }

  logger.info('Compatibility run finished', {
    event: 'compat_run_finished',
    protocol: context.route.protocol,
    runId,
    mode: context.mode,
    stream: responder.streaming,
    outcome: clientGone
      ? 'client_disconnected'
      : outcome?.kind ?? 'status_unavailable',
    queuedMs,
    durationMs: Date.now() - context.startedAt,
    ...(result instanceof CompatError
      ? { error: result.code ?? result.kind }
      : {
          truncated: result.truncated,
          usage: usageCompleteness(result.usage),
          ...(result.usage
            ? {
                inputTokens:
                  result.usage.inputTokens ?? result.usage.reportedInputTokens,
                outputTokens:
                  result.usage.outputTokens ??
                  result.usage.reportedOutputTokens,
                modelCalls: result.usage.modelCalls,
              }
            : {}),
        }),
  });

  if (clientGone) return;
  if (result instanceof CompatError) {
    if (responder.streaming) responder.failStream(result);
    else responder.sendError(result);
  } else if (responder.streaming) {
    responder.finishStream(result);
  } else {
    responder.sendCompletion(result);
  }
}

/** Answer a repeated Idempotency-Key without starting another run. */
async function answerExistingRun(
  context: Omit<DeliveryContext, 'runId' | 'mode'>,
  record: IdempotencyRecord,
): Promise<void> {
  const { res, request } = context;
  // Replays and attached retries describe the original run.
  const responder = context.route.createResponder(res, {
    runId: record.jobId,
    model: request.model,
    stream: request.stream,
    includeUsage: request.includeUsage,
  });
  res.setHeader('x-daedalus-run-id', record.jobId);
  res.setHeader('x-request-id', record.jobId);
  res.setHeader('request-id', record.jobId);
  res.setHeader('x-daedalus-idempotent-replay', 'true');
  logger.info('Compatibility idempotent retry', {
    event: 'compat_idempotent_retry',
    protocol: context.route.protocol,
    runId: record.jobId,
    state: record.state,
  });

  if (record.state === 'running') {
    const status = await readJobStatus(record.jobId);
    if (status?.conversationId && !status.conversationId.startsWith('api-')) {
      res.setHeader('x-daedalus-conversation-id', status.conversationId);
    }
    return deliverRun({
      ...context,
      responder,
      runId: record.jobId,
      mode: 'attached',
    });
  }
  const outcome = record.outcome;
  if (record.state === 'completed' && outcome?.kind === 'completed') {
    const completion: CompatCompletion = {
      text: outcome.text,
      truncated: outcome.truncated,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    };
    if (responder.streaming) {
      responder.startStream();
      responder.finishStream(completion);
    } else {
      responder.sendCompletion(completion);
    }
    return;
  }
  const error =
    record.state === 'failed' && outcome?.kind === 'error'
      ? new CompatError(outcome.error.kind, outcome.error.message, {
          code: outcome.error.code,
          details: outcome.error.details,
        })
      : new CompatError(
          'conflict',
          `A request with this Idempotency-Key may have started run ${record.jobId}, but its outcome is unknown. It will not run again; check Daedalus before retrying with a new key.`,
          {
            code: 'idempotency_outcome_unknown',
            details: { runId: record.jobId },
          },
        );
  responder.sendError(error);
}

/**
 * Handle one OpenAI or Anthropic chat request end to end. Validation,
 * authentication and admission failures are answered before any job exists;
 * a queued run executes through the same queue, worker, Rust agent loop,
 * finalization and per-user limits as the web application.
 */
export async function handleCompatChat(
  req: NextApiRequest,
  res: NextApiResponse,
  route: CompatRoute,
): Promise<void> {
  const runId = uuidv4();
  const startedAt = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('x-request-id', runId);
  res.setHeader('request-id', runId);
  let responder = route.createResponder(res, {
    runId,
    model: COMPAT_MODEL_ALIAS,
    stream: false,
    includeUsage: false,
  });

  if (!isCompatApiEnabled()) {
    responder.sendError(new CompatError('not_found', 'Not found.'));
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.setHeader('x-should-retry', 'false');
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  let principal: ApiKeyPrincipal;
  let body: unknown;
  let request: NormalizedRequest;
  let conversationId: string | null = null;
  let idempotencyKey: string | null;
  try {
    principal = await authenticateCompatRequest(req.headers);
    let rate;
    try {
      rate = await checkRateLimit(
        CHAT_SUBMISSION_RATE_LIMIT,
        principal.username,
      );
    } catch (error) {
      // As for browser submissions, a limiter outage does not block chat.
      logger.warn('Rate limit check failed; allowing request', error);
    }
    if (rate && !rate.allowed) {
      throw new CompatError(
        'rate_limit',
        'Too many requests. Wait before submitting another.',
        { retryable: true, retryAfterSeconds: rate.retryAfterSeconds },
      );
    }
    body = await readJsonBody(req);
    route.validateHeaders?.(req.headers);
    request = route.parse(body, req.headers);
    const conversationHeader = req.headers[CONVERSATION_HEADER];
    if (conversationHeader !== undefined) {
      const value = Array.isArray(conversationHeader)
        ? conversationHeader[0]
        : conversationHeader;
      if (!isValidConversationId(value)) {
        throw new CompatError(
          'invalid_request',
          INVALID_CONVERSATION_ID_MESSAGE,
          { param: 'X-Daedalus-Conversation-ID' },
        );
      }
      conversationId = value;
    }
    idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key']);
  } catch (error) {
    responder.sendError(toCompatError(error));
    return;
  }

  responder = route.createResponder(res, {
    runId,
    model: request.model,
    stream: request.stream,
    includeUsage: request.includeUsage,
  });
  if (request.ignoredParameters.length) {
    res.setHeader(
      'x-daedalus-ignored-parameters',
      [...new Set(request.ignoredParameters)].join(','),
    );
  }
  // Anthropic cache-only requests must never execute tools or create a job.
  // Daedalus has no provider prompt cache to populate.
  if (request.maxOutputTokens === 0) {
    const completion = { text: '', truncated: true };
    if (responder.streaming) {
      responder.startStream();
      responder.finishStream(completion);
    } else responder.sendCompletion(completion);
    return;
  }
  const shared = { req, res, responder, principal, request, route, startedAt };

  if (idempotencyKey) {
    const claim = await claimIdempotencyKey(
      principal.username,
      route.name,
      idempotencyKey,
      hashCompatRequest(route.name, body, conversationId),
      runId,
    ).catch((error) => {
      logger.error('Idempotency record unavailable', error);
      return null;
    });
    if (!claim) {
      responder.sendError(
        new CompatError(
          'overloaded',
          'Idempotency records are temporarily unavailable. Try again.',
          { retryable: true, retryAfterSeconds: 2 },
        ),
      );
      return;
    }
    if (claim.kind === 'mismatch') {
      responder.sendError(
        new CompatError(
          'conflict',
          'This Idempotency-Key was already used with a different request.',
          { code: 'idempotency_key_reused', param: 'Idempotency-Key' },
        ),
      );
      return;
    }
    if (claim.kind === 'existing') {
      await answerExistingRun(
        { ...shared, ...{ idempotency: { key: idempotencyKey } } },
        claim.record,
      );
      return;
    }
  }

  // Persistent conversations hold earlier turns; the request contributes its
  // final user turn. Isolated runs submit the whole history as authoritative.
  const lastAssistant = request.messages
    .map((m) => m.role)
    .lastIndexOf('assistant');
  const submitted = (
    conversationId
      ? request.messages.slice(lastAssistant + 1)
      : request.messages
  ).map((message) => ({ id: uuidv4(), ...message }));
  const lastUser = request.messages[request.messages.length - 1].content;

  try {
    const submission = await submitChatJob(
      {
        username: principal.username,
        userId: principal.userId,
        name: principal.name,
      },
      {
        jobId: runId,
        messages: submitted,
        additionalProps: null,
        conversationId,
        conversationName: `API: ${shortTitle(lastUser)}`,
        storageSessionId: `api-key-${principal.keyId}`,
        timezone: resolveTimezoneFromHeaders(req.headers),
        callerInstructions: request.instructions,
        responseMode: 'final_only',
        api: {
          protocol: route.protocol,
          persistence: conversationId ? 'conversation' : 'isolated',
        },
      },
    );
    if (submission.status === 'cancelled') {
      throw new CompatError('conflict', 'The submission was cancelled.');
    }
  } catch (error) {
    const compatError = toCompatError(error, runId);
    if (idempotencyKey) {
      const settle =
        compatError.code === 'submission_unconfirmed'
          ? settleIdempotencyKey(
              principal.username,
              route.name,
              idempotencyKey,
              runId,
              'uncertain',
            )
          : releaseIdempotencyKey(
              principal.username,
              route.name,
              idempotencyKey,
              runId,
            );
      await settle.catch((settleError) =>
        logger.warn('Could not update an idempotency record', settleError),
      );
    }
    res.setHeader('x-daedalus-run-id', runId);
    responder.sendError(compatError);
    return;
  }

  res.setHeader('x-daedalus-run-id', runId);
  if (conversationId)
    res.setHeader('x-daedalus-conversation-id', conversationId);
  await deliverRun({
    ...shared,
    runId,
    mode: 'new',
    ...(idempotencyKey ? { idempotency: { key: idempotencyKey } } : {}),
  });
}
