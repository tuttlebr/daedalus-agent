import { getRedis } from '@/server/session/redis';
import type Redis from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';

const APPROVAL_TTL_SECONDS = 300;

export interface PendingMcpApproval {
  request_id: string;
  user_id: string;
  action_type: 'mcp_mutation';
  action: string;
  reason: string;
  target: string;
  server_name: string;
  tool_name: string;
  canonical_arguments: string;
  arguments_sha256: string;
  created_at: number;
}

export interface ResolvedMcpApprovalDecision {
  decision: 'approved' | 'denied';
  requestId: string;
  pending: PendingMcpApproval;
  approvalToken?: string;
}

export interface McpApprovalPreview {
  action: string;
  reason: string;
  target: string;
  serverName: string;
  toolName: string;
  argumentsSha256: string;
  arguments: Record<string, unknown>;
}

export class McpApprovalDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpApprovalDecisionError';
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

function parsePendingApproval(
  raw: string,
  userId: string,
  requestId: string,
): PendingMcpApproval {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new McpApprovalDecisionError(
      'The pending approval record is invalid.',
    );
  }
  if (!value || typeof value !== 'object') {
    throw new McpApprovalDecisionError(
      'The pending approval record is invalid.',
    );
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
    throw new McpApprovalDecisionError(
      'The pending approval does not match the authenticated user and exact action.',
    );
  }

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(pending.canonical_arguments);
  } catch {
    throw new McpApprovalDecisionError(
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
    throw new McpApprovalDecisionError(
      'The pending approval arguments do not match their exact hash.',
    );
  }
  return pending;
}

const SENSITIVE_ARGUMENT_KEY =
  /(?:authorization|cookie|credential|password|secret|token|api[_-]?key)/i;
const SENSITIVE_STRING_VALUE =
  /(?:\bauthorization\s*[:=]|\b(?:bearer|basic)\s+\S+|\b(?:(?:[a-z0-9]+[_-])*(?:token|secret|password|credential|key)(?:[_-][a-z0-9]+)*|api[_-]?key)\s*[:=]\s*\S+|https?:\/\/[^\s/:@]+:[^\s/@]+@)/i;
const FREE_TEXT_ARGUMENT_KEY =
  /(?:^|[_-])(?:body|content|html|markdown|message|prompt|text)(?:$|[_-])/i;
const MAX_APPROVAL_PREVIEW_STRING_LENGTH = 256;

function redactArgumentValue(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactArgumentValue(item, key));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [
        childKey,
        SENSITIVE_ARGUMENT_KEY.test(childKey)
          ? '[REDACTED]'
          : redactArgumentValue(item, childKey),
      ]),
    );
  }
  if (typeof value === 'string') {
    if (SENSITIVE_STRING_VALUE.test(value)) return '[REDACTED]';
    if (FREE_TEXT_ARGUMENT_KEY.test(key)) {
      return `[REDACTED CONTENT: ${value.length} chars]`;
    }
    if (value.length > MAX_APPROVAL_PREVIEW_STRING_LENGTH) {
      return `[REDACTED TEXT: ${value.length} chars]`;
    }
  }
  return value;
}

export function buildMcpApprovalPreview(
  pending: PendingMcpApproval,
): McpApprovalPreview {
  const argumentsValue = JSON.parse(pending.canonical_arguments) as Record<
    string,
    unknown
  >;
  return {
    action: pending.action,
    reason: pending.reason,
    target: pending.target,
    serverName: pending.server_name,
    toolName: pending.tool_name,
    argumentsSha256: pending.arguments_sha256,
    arguments: redactArgumentValue(argumentsValue) as Record<string, unknown>,
  };
}

export async function getMcpApprovalPreview(
  requestId: string,
  userId: string,
  redis: Redis = getRedis(),
): Promise<McpApprovalPreview> {
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(requestId)) {
    throw new McpApprovalDecisionError('The approval request ID is invalid.');
  }
  const raw = await redis.get(pendingApprovalKey(userId, requestId));
  if (!raw) {
    throw new McpApprovalDecisionError(
      'That approval request is missing, expired, or already resolved.',
    );
  }
  return buildMcpApprovalPreview(parsePendingApproval(raw, userId, requestId));
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

export async function resolveMcpApprovalDecision(
  requestId: string,
  decision: 'approved' | 'denied',
  userId: string,
  redis: Redis = getRedis(),
): Promise<ResolvedMcpApprovalDecision> {
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(requestId)) {
    throw new McpApprovalDecisionError('The approval request ID is invalid.');
  }

  const key = pendingApprovalKey(userId, requestId);
  const raw = await redis.get(key);
  if (!raw) {
    throw new McpApprovalDecisionError(
      'That approval request is missing, expired, or already resolved.',
    );
  }
  const pending = parsePendingApproval(raw, userId, requestId);

  if (decision === 'denied') {
    const consumed = await redis.eval(DENY_PENDING_LUA, 1, key, raw);
    if (Number(consumed) !== 1) {
      throw new McpApprovalDecisionError(
        'That approval request changed or was already resolved.',
      );
    }
    return { decision, requestId, pending };
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
    throw new McpApprovalDecisionError(
      'That approval request changed or was already resolved.',
    );
  }
  return {
    decision,
    requestId,
    pending,
    approvalToken: token,
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
