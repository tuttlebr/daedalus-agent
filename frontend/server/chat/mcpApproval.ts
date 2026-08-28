import { getRedis } from '@/server/session/redis';
import type Redis from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';

const APPROVAL_REQUEST_PATTERN =
  /approval_request_id=`([A-Za-z0-9_-]{12,128})`/g;
const APPROVAL_TTL_SECONDS = 300;

const APPROVE_REPLIES = new Set([
  'approve',
  'approved',
  'confirm',
  'confirmed',
  'proceed',
  'yes',
  'yes proceed',
  'yes, proceed',
]);
const DENY_REPLIES = new Set(['cancel', 'deny', 'denied', 'no', 'stop']);

interface PendingMcpApproval {
  request_id: string;
  user_id: string;
  action_type: 'mcp_mutation';
  action: string;
  reason: string;
  target: string;
  server_name: string;
  tool_name: string;
  canonical_arguments: string;
  arguments_preview: string;
  arguments_sha256: string;
  created_at: number;
}

export interface ResolvedMcpApprovalReply {
  decision: 'approved' | 'denied';
  requestId: string;
  trustedInstruction: string;
  approvalToken?: string;
}

export class McpApprovalReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpApprovalReplyError';
  }
}

function safeUserPrefix(userId: string): string {
  return createHash('sha256').update(userId.trim()).digest('hex').slice(0, 16);
}

function pendingApprovalKey(userId: string, requestId: string): string {
  return `approval-pending:${safeUserPrefix(userId)}:${requestId}`;
}

function approvalTokenKey(userId: string, token: string): string {
  return `approval:${safeUserPrefix(userId)}:${token}`;
}

function normalizeReply(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '')
    .trim();
}

function decisionFromReply(value: unknown): 'approved' | 'denied' | null {
  const normalized = normalizeReply(value);
  if (APPROVE_REPLIES.has(normalized)) return 'approved';
  if (DENY_REPLIES.has(normalized)) return 'denied';
  return null;
}

function requestIdFromAssistantMessage(message: any): string | null {
  const content = typeof message?.content === 'string' ? message.content : '';
  let latest: string | null = null;
  APPROVAL_REQUEST_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(APPROVAL_REQUEST_PATTERN)) {
    latest = match[1];
  }
  return latest;
}

function findMcpApprovalReplyWithReview(messages: any[]): {
  decision: 'approved' | 'denied';
  requestId: string;
  reviewText: string;
} | null {
  if (!Array.isArray(messages)) return null;

  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return null;

  const decision = decisionFromReply(messages[userIndex]?.content);
  if (!decision) return null;

  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!['assistant', 'agent'].includes(message?.role)) continue;
    const requestId = requestIdFromAssistantMessage(message);
    return requestId
      ? { decision, requestId, reviewText: String(message.content) }
      : null;
  }
  return null;
}

export function findMcpApprovalReply(messages: any[]): {
  decision: 'approved' | 'denied';
  requestId: string;
} | null {
  const reply = findMcpApprovalReplyWithReview(messages);
  return reply
    ? { decision: reply.decision, requestId: reply.requestId }
    : null;
}

function parsePendingApproval(
  raw: string,
  userId: string,
  requestId: string,
): PendingMcpApproval {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new McpApprovalReplyError('The pending approval record is invalid.');
  }
  if (!value || typeof value !== 'object') {
    throw new McpApprovalReplyError('The pending approval record is invalid.');
  }
  const pending = value as PendingMcpApproval;
  const exactFields = [
    pending.action,
    pending.target,
    pending.server_name,
    pending.tool_name,
    pending.canonical_arguments,
    pending.arguments_sha256,
  ];
  if (
    pending.request_id !== requestId ||
    pending.user_id !== userId ||
    pending.action_type !== 'mcp_mutation' ||
    exactFields.some((field) => typeof field !== 'string' || !field.trim()) ||
    !/^[0-9a-f]{64}$/.test(pending.arguments_sha256)
  ) {
    throw new McpApprovalReplyError(
      'The pending approval does not match the authenticated user and exact action.',
    );
  }
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(pending.canonical_arguments);
  } catch {
    throw new McpApprovalReplyError(
      'The pending approval arguments are invalid.',
    );
  }
  if (
    !parsedArguments ||
    typeof parsedArguments !== 'object' ||
    Array.isArray(parsedArguments) ||
    createHash('sha256').update(pending.canonical_arguments).digest('hex') !==
      pending.arguments_sha256
  ) {
    throw new McpApprovalReplyError(
      'The pending approval arguments do not match their exact hash.',
    );
  }
  return pending;
}

function assertExactReviewWasPresented(
  pending: PendingMcpApproval,
  reviewText: string,
): void {
  const requiredReviewValues = [
    `target=\`${pending.target}\``,
    `server_name=\`${pending.server_name}\``,
    `tool_name=\`${pending.tool_name}\``,
    `arguments_sha256=\`${pending.arguments_sha256}\``,
    pending.arguments_preview,
    'Proceed? (yes/no)',
  ];
  if (requiredReviewValues.some((value) => !reviewText.includes(value))) {
    throw new McpApprovalReplyError(
      'The exact pending action was not fully presented for review. Ask the assistant to prepare the action again.',
    );
  }
}

const DENY_PENDING_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
`;

const APPROVE_PENDING_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
`;

export async function resolveMcpApprovalReply(
  messages: any[],
  userId: string,
  redis: Redis = getRedis(),
): Promise<ResolvedMcpApprovalReply | null> {
  const reply = findMcpApprovalReplyWithReview(messages);
  if (!reply) return null;

  const key = pendingApprovalKey(userId, reply.requestId);
  const raw = await redis.get(key);
  if (!raw) {
    throw new McpApprovalReplyError(
      'That approval request is missing, expired, or already resolved. Ask the assistant to prepare the action again.',
    );
  }
  const pending = parsePendingApproval(raw, userId, reply.requestId);
  assertExactReviewWasPresented(pending, reply.reviewText);

  if (reply.decision === 'denied') {
    const consumed = await redis.eval(DENY_PENDING_LUA, 1, key, raw);
    if (Number(consumed) !== 1) {
      throw new McpApprovalReplyError(
        'That approval request changed or was already resolved.',
      );
    }
    return {
      decision: 'denied',
      requestId: reply.requestId,
      trustedInstruction:
        '[APPROVAL] The authenticated user denied the pending MCP mutation. ' +
        'Do not execute it. Confirm that no external change was made.',
    };
  }

  const token = randomBytes(18).toString('base64url');
  const tokenPayload = JSON.stringify({
    user_id: pending.user_id,
    action_type: pending.action_type,
    target: pending.target,
    server_name: pending.server_name,
    tool_name: pending.tool_name,
    arguments_sha256: pending.arguments_sha256,
    canonical_arguments: pending.canonical_arguments,
    created_at: Math.floor(Date.now() / 1000),
  });
  const issued = await redis.eval(
    APPROVE_PENDING_LUA,
    2,
    key,
    approvalTokenKey(userId, token),
    raw,
    tokenPayload,
    String(APPROVAL_TTL_SECONDS),
  );
  if (Number(issued) !== 1) {
    throw new McpApprovalReplyError(
      'That approval request changed or was already resolved.',
    );
  }

  return {
    decision: 'approved',
    requestId: reply.requestId,
    approvalToken: token,
    trustedInstruction:
      '[APPROVAL] The authenticated user approved exactly one MCP mutation. ' +
      `Call ${pending.server_name}.${pending.tool_name} once with exactly these ` +
      `canonical arguments: ${pending.canonical_arguments}. ` +
      'Do not change the arguments or call a different mutation. The one-time ' +
      'execution credential is present only in trusted request metadata.',
  };
}

export async function revokeMcpApprovalToken(
  userId: string,
  token: string,
  redis: Redis = getRedis(),
): Promise<void> {
  if (!token) return;
  await redis.del(approvalTokenKey(userId, token));
}
