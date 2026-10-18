import type { NextApiRequest, NextApiResponse } from 'next';

import { getSession } from '@/utils/auth/session';

import { conversationJobGuardKey } from '@/server/chat/conversationJobGuard';
import { isTerminalJobStatus } from '@/server/chat/jobState';
import { getStreamSteps } from '@/server/chat/streamState';
import type { AsyncJobRequest, AsyncJobStatus } from '@/server/chat/types';
import {
  ConversationWriteError,
  readConversationForUser,
} from '@/server/session/conversationStore';
import { getRedis, jsonGet, sessionKey } from '@/server/session/redis';

type TraceLine = Record<string, unknown>;

function safeFilenameStem(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_') || 'conversation';
}

function stepIdentity(step: unknown): string | null {
  if (!step || typeof step !== 'object') return null;

  const record = step as Record<string, any>;
  const eventType = record.payload?.event_type;
  const phase =
    typeof eventType === 'string' && eventType ? eventType : 'unknown';
  const uuid = record.payload?.UUID;
  if (typeof uuid === 'string' && uuid) return `uuid:${uuid}:${phase}`;

  const nodeId = record.function_ancestry?.node_id;
  if (typeof nodeId === 'string' && nodeId) return `node:${nodeId}:${phase}`;

  return null;
}

function appendStep(
  lines: TraceLine[],
  seenStepIds: Set<string>,
  step: unknown,
  context: Record<string, unknown>,
): void {
  if (!step || typeof step !== 'object') return;

  const identity = stepIdentity(step);
  if (identity) {
    if (seenStepIds.has(identity)) return;
    seenStepIds.add(identity);
  }

  lines.push({
    ...context,
    trace_index: lines.length,
    ...(step as Record<string, unknown>),
  });
}

function appendConversationSteps(
  lines: TraceLine[],
  seenStepIds: Set<string>,
  conversation: any,
  sessionId: string,
): void {
  const messages = Array.isArray(conversation?.messages)
    ? conversation.messages
    : [];

  messages.forEach((message: any, messageIndex: number) => {
    const steps = Array.isArray(message?.intermediateSteps)
      ? message.intermediateSteps
      : [];

    steps.forEach((step: unknown, stepIndex: number) => {
      appendStep(lines, seenStepIds, step, {
        session_id: sessionId,
        conversation_id: conversation?.id || sessionId,
        conversation_name: conversation?.name || '',
        message_index: messageIndex,
        message_id: message?.id || null,
        role: message?.role || null,
        turn_id: message?.metadata?.turnId || null,
        job_id: message?.metadata?.jobId || null,
        step_index: stepIndex,
        live: false,
      });
    });
  });
}

/**
 * The per-user conversation guard names the one response that can still be
 * running for this conversation. Its steps live in the worker's append-only
 * stream state until finalization moves them into the saved conversation.
 */
async function activeConversationJob(
  username: string,
  conversationId: string,
): Promise<{ jobId: string; status: AsyncJobStatus | null } | null> {
  const raw = await getRedis().get(
    conversationJobGuardKey(username, conversationId),
  );
  if (!raw) return null;
  let guard: any;
  try {
    guard = JSON.parse(raw);
  } catch {
    return null;
  }
  const jobId = guard?.jobId;
  if (
    guard?.userId !== username ||
    guard?.conversationId !== conversationId ||
    typeof jobId !== 'string' ||
    !jobId
  ) {
    return null;
  }

  const [request, status] = (await Promise.all([
    jsonGet(sessionKey(['async-job-request', jobId])),
    jsonGet(sessionKey(['async-job-status', jobId])),
  ])) as [AsyncJobRequest | null, AsyncJobStatus | null];
  if (
    request?.userId !== username ||
    request?.conversationId !== conversationId ||
    (status &&
      (status.finalizedAt !== undefined || isTerminalJobStatus(status.status)))
  ) {
    return null;
  }
  return { jobId, status };
}

async function appendLiveSteps(
  lines: TraceLine[],
  seenStepIds: Set<string>,
  username: string,
  conversationId: string,
  conversationName: string,
  sessionId: string,
): Promise<void> {
  const active = await activeConversationJob(username, conversationId);
  if (!active) return;
  const { jobId, status } = active;
  const steps = await getStreamSteps(
    jobId,
    Array.isArray(status?.intermediateSteps) ? status.intermediateSteps : [],
  );

  steps.forEach((step: unknown, stepIndex: number) => {
    appendStep(lines, seenStepIds, step, {
      session_id: sessionId,
      conversation_id: conversationId,
      conversation_name: conversationName,
      message_index: null,
      message_id: null,
      role: 'assistant',
      turn_id: status?.turnId || null,
      job_id: jobId,
      step_index: stepIndex,
      live: true,
    });
  });
}

function toJsonl(lines: TraceLine[]): string {
  if (lines.length === 0) return '';
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getSession(req, res);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Invalid conversation ID' });
  }

  try {
    const conversation = await readConversationForUser(session.username, id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const exportSessionId =
      typeof conversation?.id === 'string' && conversation.id
        ? conversation.id
        : id;
    const lines: TraceLine[] = [];
    const seenStepIds = new Set<string>();

    appendConversationSteps(lines, seenStepIds, conversation, exportSessionId);
    await appendLiveSteps(
      lines,
      seenStepIds,
      session.username,
      id,
      conversation?.name || '',
      exportSessionId,
    );

    const filename = `${safeFilenameStem(exportSessionId)}.jsonl`;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(toJsonl(lines));
  } catch (error) {
    if (error instanceof ConversationWriteError)
      return res.status(403).json({ error: error.message });
    console.error('Error exporting conversation traces:', error);
    return res.status(500).json({ error: 'Failed to export traces' });
  }
}
