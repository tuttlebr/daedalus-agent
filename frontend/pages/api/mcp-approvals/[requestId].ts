import type { NextApiRequest, NextApiResponse } from 'next';

import { buildBackendUrlFromBase } from '@/utils/app/backendApi';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout';

import {
  getNatBaseUrl,
  resolveAsyncBackendBaseUrls,
} from '@/server/chat/backendSelection';
import {
  McpApprovalDecisionError,
  resolveMcpApprovalDecision,
  revokeMcpApprovalToken,
} from '@/server/chat/mcpApproval';
import { buildNatRequestHeaders } from '@/server/chat/natMessages';
import type { AsyncJobRequest } from '@/server/chat/types';
import { saveOAuthCallbackTarget } from '@/server/mcpOAuth';
import { requireAuthenticatedUser } from '@/server/session/_utils';
import { jsonGet, jsonSetWithExpiry, sessionKey } from '@/server/session/redis';
import { createHash } from 'node:crypto';

const APPROVAL_STATUS_TTL_SECONDS = 7 * 24 * 60 * 60;
const EXECUTION_START_TIMEOUT_MS = 135_000;
const EXECUTION_POLL_TIMEOUT_MS = 15_000;

interface ApprovalExecutionState {
  requestId: string;
  userId: string;
  decision: 'approved' | 'denied';
  status: string;
  backendBaseUrl?: string;
  natSessionId?: string;
  timezone?: string;
  conversationId?: string;
  executionId?: string;
  authUrl?: string;
  oauthState?: string;
  error?: string;
  updatedAt: number;
}

function statusKey(userId: string, requestId: string): string {
  const safeUser = createHash('sha256')
    .update(userId.trim())
    .digest('hex')
    .slice(0, 16);
  return sessionKey(['mcp-approval-status', safeUser, requestId]);
}

async function persistState(state: ApprovalExecutionState): Promise<void> {
  await jsonSetWithExpiry(
    statusKey(state.userId, state.requestId),
    state,
    APPROVAL_STATUS_TTL_SECONDS,
  );
}

async function loadOwnedJob(
  jobId: unknown,
  userId: string,
): Promise<AsyncJobRequest | null> {
  if (typeof jobId !== 'string' || !jobId) return null;
  const job = (await jsonGet(
    sessionKey(['async-job-request', jobId]),
  )) as AsyncJobRequest | null;
  return job?.userId === userId ? job : null;
}

async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  requestId: string,
  userId: string,
) {
  const decision = req.body?.decision;
  if (decision !== 'approved' && decision !== 'denied') {
    return res
      .status(400)
      .json({ error: 'Decision must be approved or denied' });
  }

  let resolved: Awaited<ReturnType<typeof resolveMcpApprovalDecision>>;
  try {
    resolved = await resolveMcpApprovalDecision(requestId, decision, userId);
  } catch (error) {
    if (error instanceof McpApprovalDecisionError) {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }

  if (decision === 'denied') {
    const state: ApprovalExecutionState = {
      requestId,
      userId,
      decision,
      status: 'denied',
      updatedAt: Date.now(),
    };
    await persistState(state);
    return res.status(200).json({ status: state.status });
  }

  const approvalToken = resolved.approvalToken!;
  const job = await loadOwnedJob(req.body?.jobId, userId);
  const backendBaseUrl = job
    ? getNatBaseUrl(job)
    : (await resolveAsyncBackendBaseUrls())[0];
  const natSessionId = job?.natSessionId || userId;
  const executeUrl = buildBackendUrlFromBase(
    backendBaseUrl,
    `/v1/mcp-approvals/${encodeURIComponent(requestId)}/execute`,
  );

  let response: Response;
  try {
    response = await fetchWithTimeout(
      executeUrl,
      {
        method: 'POST',
        headers: buildNatRequestHeaders(
          userId,
          { 'Content-Type': 'application/json' },
          natSessionId,
          job?.timezone,
          job?.conversationId,
          requestId,
          approvalToken,
        ),
        body: JSON.stringify({
          server_name: resolved.pending.server_name,
          tool_name: resolved.pending.tool_name,
          canonical_arguments: resolved.pending.canonical_arguments,
          arguments_sha256: resolved.pending.arguments_sha256,
        }),
      },
      EXECUTION_START_TIMEOUT_MS,
    );
  } catch (error) {
    await revokeMcpApprovalToken(userId, approvalToken).catch(() => {});
    await persistState({
      requestId,
      userId,
      decision,
      status: 'failed',
      backendBaseUrl,
      natSessionId,
      timezone: job?.timezone,
      conversationId: job?.conversationId,
      error: 'The approved operation could not reach the backend',
      updatedAt: Date.now(),
    }).catch(() => {});
    throw error;
  }

  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok && response.status !== 202) {
    await revokeMcpApprovalToken(userId, approvalToken).catch(() => {});
    const error =
      typeof payload.error === 'string'
        ? payload.error
        : 'The approved operation failed';
    await persistState({
      requestId,
      userId,
      decision,
      status: 'failed',
      backendBaseUrl,
      natSessionId,
      timezone: job?.timezone,
      conversationId: job?.conversationId,
      error,
      updatedAt: Date.now(),
    });
    return res.status(response.status).json({
      status: 'failed',
      error,
    });
  }

  const state: ApprovalExecutionState = {
    requestId,
    userId,
    decision,
    status: typeof payload.status === 'string' ? payload.status : 'running',
    backendBaseUrl,
    natSessionId,
    timezone: job?.timezone,
    conversationId: job?.conversationId,
    executionId:
      typeof payload.executionId === 'string' ? payload.executionId : undefined,
    authUrl: typeof payload.authUrl === 'string' ? payload.authUrl : undefined,
    oauthState:
      typeof payload.oauthState === 'string' ? payload.oauthState : undefined,
    updatedAt: Date.now(),
  };
  if (state.oauthState && state.authUrl) {
    await saveOAuthCallbackTarget(state.oauthState, backendBaseUrl, requestId);
  }
  await persistState(state);
  return res.status(response.status).json({
    status: state.status,
    authUrl: state.authUrl,
  });
}

async function handleGet(
  res: NextApiResponse,
  requestId: string,
  userId: string,
) {
  const state = (await jsonGet(
    statusKey(userId, requestId),
  )) as ApprovalExecutionState | null;
  if (!state || state.userId !== userId) {
    return res.status(404).json({ error: 'Approval state not found' });
  }
  if (
    !state.executionId ||
    !state.backendBaseUrl ||
    ['completed', 'failed', 'denied'].includes(state.status)
  ) {
    return res.status(200).json({
      status: state.status,
      authUrl: state.authUrl,
      error: state.error,
    });
  }

  const response = await fetchWithTimeout(
    buildBackendUrlFromBase(
      state.backendBaseUrl,
      `/executions/${encodeURIComponent(state.executionId)}`,
    ),
    {
      method: 'GET',
      headers: buildNatRequestHeaders(
        userId,
        {},
        state.natSessionId,
        state.timezone,
        state.conversationId,
        requestId,
      ),
    },
    EXECUTION_POLL_TIMEOUT_MS,
  );
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    return res.status(response.status).json({
      error: 'Unable to read approved operation status',
    });
  }

  state.status =
    typeof payload.status === 'string' ? payload.status : state.status;
  state.authUrl =
    typeof payload.auth_url === 'string' ? payload.auth_url : state.authUrl;
  state.oauthState =
    typeof payload.oauth_state === 'string'
      ? payload.oauth_state
      : state.oauthState;
  state.error = typeof payload.error === 'string' ? payload.error : undefined;
  state.updatedAt = Date.now();
  if (state.oauthState && state.authUrl) {
    await saveOAuthCallbackTarget(
      state.oauthState,
      state.backendBaseUrl,
      requestId,
    );
  }
  await persistState(state);
  return res.status(200).json({
    status: state.status,
    authUrl: state.authUrl,
    error: state.error,
  });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  const requestId = Array.isArray(req.query.requestId)
    ? req.query.requestId[0]
    : req.query.requestId;
  if (!requestId || !/^[A-Za-z0-9_-]{12,128}$/.test(requestId)) {
    return res.status(400).json({ error: 'Invalid approval request ID' });
  }

  res.setHeader('Cache-Control', 'private, no-store');
  try {
    if (req.method === 'POST') {
      return await handlePost(req, res, requestId, session.username);
    }
    if (req.method === 'GET') {
      return await handleGet(res, requestId, session.username);
    }
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).end('Method Not Allowed');
  } catch (error) {
    console.error('MCP approval execution failed', error);
    return res.status(502).json({
      status: 'failed',
      error: 'The approved operation could not reach the backend',
    });
  }
}
