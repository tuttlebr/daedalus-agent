import type { NextApiRequest, NextApiResponse } from 'next';

import { getSession } from '@/utils/auth/session';

import {
  getRedis,
  getStreamingStates,
  jsonGet,
  sessionKey,
} from '@/server/session/redis';

type TraceLine = Record<string, unknown>;

async function verifyConversationOwnership(
  username: string,
  conversationId: string,
): Promise<boolean> {
  const redis = getRedis();
  const userConversationsKey = sessionKey(['user', username, 'conversations']);
  return (await redis.sismember(userConversationsKey, conversationId)) === 1;
}

function safeFilenameStem(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_') || 'conversation';
}

function stepIdentity(step: unknown): string | null {
  if (!step || typeof step !== 'object') return null;

  const record = step as Record<string, any>;
  const uuid = record.payload?.UUID;
  if (typeof uuid === 'string' && uuid) return `uuid:${uuid}`;

  const nodeId = record.function_ancestry?.node_id;
  if (typeof nodeId === 'string' && nodeId) return `node:${nodeId}`;

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

async function appendLiveSteps(
  lines: TraceLine[],
  seenStepIds: Set<string>,
  username: string,
  conversationId: string,
  conversationName: string,
  sessionId: string,
): Promise<void> {
  const streamingStates = await getStreamingStates(username);
  const streamingState = streamingStates[conversationId];
  const jobId = streamingState?.sessionId;
  if (!jobId) return;

  const stepsKey = sessionKey(['async-job-steps', jobId]);
  const statusKey = sessionKey(['async-job-status', jobId]);
  const liveSteps = (await jsonGet(stepsKey)) as unknown;
  const status = (await jsonGet(statusKey)) as any;
  const steps = Array.isArray(liveSteps)
    ? liveSteps
    : Array.isArray(status?.intermediateSteps)
    ? status.intermediateSteps
    : [];

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
    const ownsConversation = await verifyConversationOwnership(
      session.username,
      id,
    );
    if (!ownsConversation) {
      return res.status(403).json({
        error: 'Forbidden: You do not have access to this conversation',
      });
    }

    const conversationKey = sessionKey(['conversation', id]);
    const conversation = await jsonGet(conversationKey);
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
    console.error('Error exporting conversation traces:', error);
    return res.status(500).json({ error: 'Failed to export traces' });
  }
}
