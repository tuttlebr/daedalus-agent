import { fetchWithTimeout } from '@/utils/fetchWithTimeout';

import handler from '@/pages/api/mcp-approvals/[requestId]';

import {
  resolveMcpApprovalDecision,
  revokeMcpApprovalToken,
} from '@/server/chat/mcpApproval';
import { requireAuthenticatedUser } from '@/server/session/_utils';
import { jsonGet, jsonSetWithExpiry } from '@/server/session/redis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/chat/backendSelection', () => ({
  getNatBaseUrl: vi.fn(),
  resolveAsyncBackendBaseUrls: vi
    .fn()
    .mockResolvedValue(['http://backend:8000']),
}));
vi.mock('@/server/chat/mcpApproval', async (original) => ({
  ...(await original<typeof import('@/server/chat/mcpApproval')>()),
  resolveMcpApprovalDecision: vi.fn(),
  revokeMcpApprovalToken: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/server/chat/natMessages', () => ({
  buildNatRequestHeaders: vi.fn().mockReturnValue({ 'x-user-id': 'alice' }),
}));
vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: vi.fn(),
}));
vi.mock('@/server/session/redis', () => ({
  getRedis: vi.fn(),
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn().mockResolvedValue(undefined),
  sessionKey: (parts: string[]) => parts.join(':'),
}));
vi.mock('@/server/mcpOAuth', () => ({ saveOAuthCallbackTarget: vi.fn() }));
vi.mock('@/utils/fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }));

describe('MCP approval rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuthenticatedUser).mockResolvedValue({
      username: 'alice',
    } as any);
    vi.mocked(resolveMcpApprovalDecision).mockResolvedValue({
      decision: 'approved',
      requestId: 'approval_request_12345',
      approvalToken: 'synthetic-token',
      pending: {
        request_id: 'approval_request_12345',
        user_id: 'alice',
        action_type: 'mcp_mutation',
        action: 'Read cluster summary',
        reason: 'Review',
        target: 'exact-arguments',
        server_name: 'fixture',
        tool_name: 'inspect',
        canonical_arguments: '{}',
        arguments_sha256: 'a'.repeat(64),
        created_at: 1,
      },
    });
  });

  it.each([
    [
      { detail: 'Direct execution is limited to approval-gated operations' },
      'Direct execution is limited to approval-gated operations',
    ],
    [
      { error: 'Exact MCP approval credential is missing or invalid' },
      'Exact MCP approval credential is missing or invalid',
    ],
    [{ detail: [{ input: 'private text' }] }, 'The approved operation failed'],
  ])(
    'retains the safe backend rejection across subsequent status reads',
    async (body, message) => {
      vi.mocked(fetchWithTimeout).mockResolvedValue(
        new Response(JSON.stringify(body), { status: 409 }),
      );
      const response = () =>
        ({
          status: vi.fn().mockReturnThis(),
          json: vi.fn().mockReturnThis(),
          setHeader: vi.fn(),
        } as any);
      const res = response();
      await handler(
        {
          method: 'POST',
          query: { requestId: 'approval_request_12345' },
          body: { decision: 'approved' },
        } as any,
        res,
      );
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        status: 'failed',
        error: message,
      });
      expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
      expect(revokeMcpApprovalToken).toHaveBeenCalledWith(
        'alice',
        'synthetic-token',
      );
      const saved = vi.mocked(jsonSetWithExpiry).mock.calls.at(-1)![1];
      expect(saved).toMatchObject({
        status: 'failed',
        error: message,
        userId: 'alice',
      });
      vi.mocked(jsonGet).mockResolvedValue(saved as any);
      const poll = response();
      await handler(
        {
          method: 'GET',
          query: { requestId: 'approval_request_12345' },
        } as any,
        poll,
      );
      expect(poll.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed', error: message }),
      );
      expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    },
  );

  it('audits an approved operation that completes before execute returns', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      new Response(
        JSON.stringify({ status: 'completed', executionId: 'execution-1' }),
        { status: 200 },
      ),
    );
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

    try {
      await handler(
        {
          method: 'POST',
          query: { requestId: 'approval_request_12345' },
          body: { decision: 'approved' },
        } as any,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(200);
      const results = info.mock.calls.filter(
        ([message]) => message === '[SECURITY] MCP approval result',
      );
      expect(results).toHaveLength(1);
      expect(results[0][1]).toMatchObject({
        actor: 'alice',
        value: 'completed',
        toolName: 'inspect',
      });
      // A later poll returns the terminal state without logging it again.
      const saved = vi.mocked(jsonSetWithExpiry).mock.calls.at(-1)![1];
      expect(saved).toMatchObject({ status: 'completed', resultLogged: true });
    } finally {
      info.mockRestore();
    }
  });
});
