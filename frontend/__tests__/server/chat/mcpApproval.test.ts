import {
  McpApprovalReplyError,
  findMcpApprovalReply,
  resolveMcpApprovalReply,
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

function conversation(reply = 'yes'): any[] {
  return [
    { role: 'user', content: 'Update the document.' },
    {
      role: 'assistant',
      content:
        'Please review this update.\n\n' +
        'Approval scope: action_type=`mcp_mutation`, ' +
        'target=`document/doc-1`, server_name=`docs_mcp_server`, ' +
        `tool_name=\`update_doc\`, approval_request_id=\`${requestId}\`, ` +
        `arguments_sha256=\`${argumentsSha256}\`.\n\n` +
        `Arguments for review:\n\n\`\`\`json\n${canonicalArguments}\n\`\`\`` +
        '\n\nProceed? (yes/no)',
    },
    { role: 'user', content: reply },
  ];
}

function pendingPayload(): string {
  return JSON.stringify({
    request_id: requestId,
    user_id: userId,
    action_type: 'mcp_mutation',
    action: 'Update doc-1',
    reason: 'The user requested it',
    target: 'document/doc-1',
    server_name: 'docs_mcp_server',
    tool_name: 'update_doc',
    canonical_arguments: canonicalArguments,
    arguments_preview: canonicalArguments,
    arguments_sha256: argumentsSha256,
    created_at: 1,
  });
}

describe('interactive MCP approval handoff', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
    redis.store.set(pendingKey, pendingPayload());
  });

  it('recognizes only a strict decision after an exact approval request', () => {
    expect(findMcpApprovalReply(conversation())).toEqual({
      decision: 'approved',
      requestId,
    });
    expect(findMcpApprovalReply(conversation('no'))).toEqual({
      decision: 'denied',
      requestId,
    });
    expect(findMcpApprovalReply(conversation('yes, but change the text'))).toBe(
      null,
    );
  });

  it('does not approve an id that was hidden in a tool trace', () => {
    const messages = conversation();
    messages[1] = {
      role: 'assistant',
      content: 'Please approve the exact action shown in the tool trace.',
      intermediateSteps: [
        {
          payload: {
            data: {
              output: `approval_request_id=\`${requestId}\``,
            },
          },
        },
      ],
    };
    expect(findMcpApprovalReply(messages)).toBeNull();
  });

  it('rejects a visible request id without the exact review details', async () => {
    const messages = conversation();
    messages[1] = {
      role: 'assistant',
      content: `approval_request_id=\`${requestId}\` Proceed? (yes/no)`,
    };
    await expect(
      resolveMcpApprovalReply(messages, userId, redis as any),
    ).rejects.toThrow('not fully presented for review');
    expect(redis.store.has(pendingKey)).toBe(true);
  });

  it('atomically converts approval into an exact short-lived credential', async () => {
    const result = await resolveMcpApprovalReply(
      conversation(),
      userId,
      redis as any,
    );

    expect(result).toMatchObject({
      decision: 'approved',
      requestId,
    });
    expect(result?.approvalToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(redis.store.has(pendingKey)).toBe(false);

    const tokenEntry = Array.from(redis.store.entries()).find(([key]) =>
      key.startsWith(`approval:${safeUser}:`),
    );
    expect(tokenEntry).toBeDefined();
    expect(JSON.parse(tokenEntry![1])).toMatchObject({
      user_id: userId,
      action_type: 'mcp_mutation',
      target: 'document/doc-1',
      server_name: 'docs_mcp_server',
      tool_name: 'update_doc',
      arguments_sha256: argumentsSha256,
      canonical_arguments: canonicalArguments,
    });
  });

  it('deletes a denied intent without issuing a credential', async () => {
    const result = await resolveMcpApprovalReply(
      conversation('no'),
      userId,
      redis as any,
    );

    expect(result).toMatchObject({ decision: 'denied', requestId });
    expect(redis.store.size).toBe(0);
  });

  it('rejects an expired or replayed approval', async () => {
    await resolveMcpApprovalReply(conversation(), userId, redis as any);
    await expect(
      resolveMcpApprovalReply(conversation(), userId, redis as any),
    ).rejects.toBeInstanceOf(McpApprovalReplyError);
  });
});
