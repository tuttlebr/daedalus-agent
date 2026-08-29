import { parseMcpApprovalMarker } from '@/utils/app/mcpApproval';

import {
  McpApprovalDecisionError,
  resolveMcpApprovalDecision,
} from '@/server/chat/mcpApproval';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

class FakeRedis {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async eval(
    _script: string,
    keyCount: number,
    ...args: Array<string | number>
  ): Promise<number> {
    const values = args.map(String);
    if (keyCount === 1) {
      const [pendingKey, expectedRaw] = values;
      if (this.store.get(pendingKey) !== expectedRaw) return 0;
      this.store.delete(pendingKey);
      return 1;
    }
    const [pendingKey, tokenKey, expectedRaw, tokenPayload] = values;
    if (this.store.get(pendingKey) !== expectedRaw) return 0;
    this.store.delete(pendingKey);
    this.store.set(tokenKey, tokenPayload);
    return 1;
  }
}

const userId = 'alice';
const requestId = 'approval_request_12345';
const canonicalArguments = '{"document_id":"doc-1","text":"hello"}';
const argumentsSha256 = createHash('sha256')
  .update(canonicalArguments)
  .digest('hex');
const safeUser = createHash('sha256').update(userId).digest('hex').slice(0, 16);
const pendingKey = `approval-pending:${safeUser}:${requestId}`;

function pendingPayload(): string {
  return JSON.stringify({
    request_id: requestId,
    user_id: userId,
    action_type: 'mcp_mutation',
    action: 'Update Google document doc-1 (1 KiB payload)',
    reason: 'This MCP operation changes external data.',
    target: 'doc-1',
    server_name: 'docs_mcp_server',
    tool_name: 'update_doc',
    canonical_arguments: canonicalArguments,
    arguments_sha256: argumentsSha256,
    created_at: 1,
  });
}

describe('button-based MCP approval handoff', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
    redis.store.set(pendingKey, pendingPayload());
  });

  it('parses only the compact structured marker', () => {
    const markerPayload = {
      version: 1,
      requestId,
      serverName: 'docs_mcp_server',
      toolName: 'update_doc',
      target: 'doc-1',
      summary: 'Update Google document doc-1 (1 KiB payload)',
      argumentsSha256,
    };
    const encoded = Buffer.from(JSON.stringify(markerPayload)).toString(
      'base64url',
    );
    expect(
      parseMcpApprovalMarker(`<!--daedalus-mcp-approval:${encoded}-->`),
    ).toEqual(markerPayload);
    expect(
      parseMcpApprovalMarker('Please approve this document text'),
    ).toBeNull();
  });

  it('converts a persisted legacy review into a metadata-only card', () => {
    const review =
      '**Action requiring confirmation:** Update it\n\n' +
      'Proceed? (yes/no)\n\n' +
      'Approval scope: action_type=`mcp_mutation`, ' +
      'target=`doc-1`, server_name=`docs_mcp_server`, ' +
      `tool_name=\`update_doc\`, approval_request_id=\`${requestId}\`, ` +
      `arguments_sha256=\`${argumentsSha256}\`.\n\n` +
      `Arguments for review:\n\n\`\`\`json\n${canonicalArguments}\n\`\`\``;

    expect(parseMcpApprovalMarker(review)).toEqual({
      version: 1,
      requestId,
      serverName: 'docs_mcp_server',
      toolName: 'update_doc',
      target: 'doc-1',
      summary: 'Update Google document doc-1',
      argumentsSha256,
    });
  });

  it('atomically converts an approve button decision into one exact credential', async () => {
    const result = await resolveMcpApprovalDecision(
      requestId,
      'approved',
      userId,
      redis as any,
    );

    expect(result).toMatchObject({ decision: 'approved', requestId });
    expect(result.approvalToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(result.pending.canonical_arguments).toBe(canonicalArguments);
    expect(redis.store.has(pendingKey)).toBe(false);
    const tokenEntry = Array.from(redis.store.entries()).find(([key]) =>
      key.startsWith(`approval:${safeUser}:`),
    );
    expect(JSON.parse(tokenEntry![1])).toMatchObject({
      user_id: userId,
      server_name: 'docs_mcp_server',
      tool_name: 'update_doc',
      arguments_sha256: argumentsSha256,
      canonical_arguments: canonicalArguments,
    });
  });

  it('deletes a denied intent without issuing a credential', async () => {
    const result = await resolveMcpApprovalDecision(
      requestId,
      'denied',
      userId,
      redis as any,
    );
    expect(result).toMatchObject({ decision: 'denied', requestId });
    expect(redis.store.size).toBe(0);
  });

  it('rejects an expired or replayed button decision', async () => {
    await resolveMcpApprovalDecision(
      requestId,
      'approved',
      userId,
      redis as any,
    );
    await expect(
      resolveMcpApprovalDecision(requestId, 'approved', userId, redis as any),
    ).rejects.toBeInstanceOf(McpApprovalDecisionError);
  });
});
