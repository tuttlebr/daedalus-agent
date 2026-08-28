import {
  resolveTimezoneFromHeaders,
  stripTimezoneHeaders,
  withInternalBackendAuth,
  withTimezoneHeader,
} from '@/utils/server/backendAuth';

import { createHash } from 'node:crypto';

const CONVERSATION_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const APPROVAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

// Normalize messages for the OpenAI-compatible /v1/chat/completions backend.
// Preserves the full conversation history (both user and assistant turns) so
// follow-ups like "convert your last response to HTML" have actual context.
// Strips Daedalus-internal fields that aren't part of the OpenAI schema so the
// backend agent and downstream LLMs receive a clean payload.
export function buildBoundedMessagesForNat(messages: any[]): any[] {
  if (!Array.isArray(messages)) return messages;

  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;

      const rawRole = typeof message.role === 'string' ? message.role : '';
      const role = rawRole === 'agent' ? 'assistant' : rawRole;
      if (role !== 'user' && role !== 'assistant') {
        return null;
      }

      const content =
        typeof message.content === 'string' ? message.content : '';
      // Drop assistant messages with empty content — Bedrock/Claude reject
      // ContentBlock entries whose `text` field is blank.
      if (role === 'assistant' && !content.trim()) {
        return null;
      }

      return { role, content };
    })
    .filter(Boolean);
}

export function buildNatSessionId(username: string): string {
  // NAT uses this cookie as the per-user MCP/OAuth cache key. Keep it opaque,
  // but stable across turns so a completed Google authorization remains usable
  // for the authenticated user instead of starting a new OAuth flow per job.
  return `daedalus-user-${createHash('sha256')
    .update(username)
    .digest('hex')
    .slice(0, 32)}`;
}

export function buildNatRequestHeaders(
  username: string,
  headers: Record<string, string> = {},
  natSessionId?: string,
  timezone?: string,
  conversationId?: string,
  requestId?: string,
  approvalToken?: string,
): Record<string, string> {
  const {
    Cookie: existingCookie,
    cookie: lowercaseExistingCookie,
    ...restHeaders
  } = headers;
  const sessionId = natSessionId?.trim() || username;
  const natCookie = `nat-session=${encodeURIComponent(sessionId)}`;
  const cookieHeader = existingCookie || lowercaseExistingCookie;
  const resolvedTimezone = timezone || resolveTimezoneFromHeaders(headers);
  const conversationCandidate = conversationId?.trim();
  const trustedConversationId =
    conversationCandidate &&
    CONVERSATION_SCOPE_PATTERN.test(conversationCandidate)
      ? conversationCandidate
      : undefined;
  const requestCandidate = requestId?.trim();
  const trustedRequestId =
    requestCandidate && REQUEST_SCOPE_PATTERN.test(requestCandidate)
      ? requestCandidate
      : undefined;
  const approvalCandidate = approvalToken?.trim();
  const trustedApprovalToken =
    approvalCandidate && APPROVAL_TOKEN_PATTERN.test(approvalCandidate)
      ? approvalCandidate
      : undefined;

  return withInternalBackendAuth(
    withTimezoneHeader(
      {
        ...stripTimezoneHeaders(restHeaders),
        'x-user-id': username,
        ...(trustedConversationId
          ? { 'x-conversation-id': trustedConversationId }
          : {}),
        ...(trustedRequestId
          ? { 'x-daedalus-request-id': trustedRequestId }
          : {}),
        ...(trustedApprovalToken
          ? { 'x-daedalus-approval-token': trustedApprovalToken }
          : {}),
        Cookie: cookieHeader ? `${cookieHeader}; ${natCookie}` : natCookie,
      },
      resolvedTimezone,
    ),
  );
}
