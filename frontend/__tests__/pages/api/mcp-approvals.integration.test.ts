import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: vi.fn().mockResolvedValue({ username: 'alice' }),
}));
vi.mock('@/utils/fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }));

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'MCP approval status with real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let handler: typeof import('@/pages/api/mcp-approvals/[requestId]').default;
    let fetchStatus: typeof import('@/utils/fetchWithTimeout').fetchWithTimeout;
    let client: ReturnType<typeof redis.getRedis>;

    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('Disposable REDIS_URL required');
      redis = await import('@/server/session/redis');
      handler = (await import('@/pages/api/mcp-approvals/[requestId]')).default;
      fetchStatus = (await import('@/utils/fetchWithTimeout')).fetchWithTimeout;
      client = redis.getRedis();
      if (client.status === 'wait') await client.connect();
    });

    afterAll(() => {
      client?.disconnect();
      redis?.getPublisher().disconnect();
    });

    it.each(['immediate', 'polled', 'expired-job'])(
      'delivers %s execution output to the saved conversation without replaying the call',
      async (mode) => {
        const { saveConversationForUser, readConversationForUser } =
          await import('@/server/session/conversationStore');
        const requestId = randomUUID();
        const conversationId = randomUUID();
        const jobId = randomUUID();
        const safeUser = createHash('sha256')
          .update('alice')
          .digest('hex')
          .slice(0, 16);
        const pendingKey = `approval-pending:${safeUser}:${requestId}`;
        const statusKey = redis.sessionKey([
          'mcp-approval-status',
          safeUser,
          requestId,
        ]);
        const jobKey = redis.sessionKey(['async-job-request', jobId]);
        const canonicalArguments = '{"namespace":"daedalus","types":"pods"}';
        const digest = createHash('sha256')
          .update(canonicalArguments)
          .digest('hex');
        const marker = `<!--daedalus-mcp-approval:${Buffer.from(
          JSON.stringify({
            version: 1,
            requestId,
            serverName: 'k8s_mcp_server',
            toolName: 'getNamespaceResources',
            target: 'daedalus',
            summary: 'Read pods',
            argumentsSha256: digest,
          }),
        ).toString('base64url')}-->`;
        const result = { content: 'pod-a Running\npod-b Running' };
        await client.set(
          pendingKey,
          JSON.stringify({
            request_id: requestId,
            user_id: 'alice',
            action_type: 'mcp_mutation',
            action: 'Read pods',
            reason: 'Review',
            target: 'daedalus',
            server_name: 'k8s_mcp_server',
            tool_name: 'getNamespaceResources',
            canonical_arguments: canonicalArguments,
            arguments_sha256: digest,
            created_at: 1,
          }),
          'EX',
          120,
        );
        await redis.jsonSetWithExpiry(
          jobKey,
          {
            jobId,
            userId: 'alice',
            conversationId,
            natBaseUrl: 'http://backend:8000',
          },
          120,
        );
        if (mode === 'expired-job') await client.del(jobKey);
        await saveConversationForUser(
          'alice',
          conversationId,
          () => ({
            id: conversationId,
            name: 'Read pods',
            messages: [
              {
                id: 'a1',
                role: 'assistant',
                content: marker,
                metadata: { jobId },
              },
            ],
          }),
          true,
        );
        vi.mocked(fetchStatus).mockReset();
        if (mode === 'polled')
          vi.mocked(fetchStatus).mockResolvedValueOnce(
            Response.json(
              { status: 'running', executionId: 'fixture-execution' },
              { status: 202 },
            ),
          );
        vi.mocked(fetchStatus).mockResolvedValueOnce(
          Response.json({
            status: 'completed',
            executionId: 'fixture-execution',
            result,
          }),
        );
        const response = () =>
          ({
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis(),
            setHeader: vi.fn(),
          } as any);
        try {
          const first = response();
          await handler(
            {
              method: 'POST',
              query: { requestId },
              body: { decision: 'approved', jobId, conversationId },
            } as any,
            first,
          );
          let completed = first;
          if (mode === 'polled') {
            completed = response();
            await handler(
              { method: 'GET', query: { requestId } } as any,
              completed,
            );
          }
          expect(completed.json).toHaveBeenCalledWith(
            expect.objectContaining({
              status: 'completed',
              result,
              conversationPending: false,
            }),
          );
          const saved = await readConversationForUser('alice', conversationId);
          expect(saved?.messages[0].content).toContain(result.content);
          expect(saved?.messages[0].content).not.toContain(
            '<!--daedalus-mcp-approval:',
          );
          expect(saved?.messages[0].metadata.mcpApprovalRequestId).toBe(
            requestId,
          );
          expect(await redis.jsonGet(statusKey)).toMatchObject({
            result,
            resultSaved: true,
          });
          const reload = response();
          await handler({ method: 'GET', query: { requestId } } as any, reload);
          expect(reload.json).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'completed', result }),
          );
          expect(
            vi
              .mocked(fetchStatus)
              .mock.calls.filter(([, init]) => init?.method === 'POST'),
          ).toHaveLength(1);
          expect(fetchStatus).toHaveBeenCalledTimes(mode === 'polled' ? 2 : 1);
          expect(await client.exists(pendingKey)).toBe(0);
        } finally {
          // The synthetic backend does not consume the real one-use credential.
          const headers = vi.mocked(fetchStatus).mock.calls[0]?.[1]
            ?.headers as Record<string, string>;
          const token = headers?.['x-daedalus-approval-token'];
          await client.del(
            pendingKey,
            statusKey,
            jobKey,
            redis.sessionKey(['conversation', conversationId]),
            ...(token ? [`approval:${safeUser}:${token}`] : []),
          );
          await client.srem(
            redis.sessionKey(['user', 'alice', 'conversations']),
            conversationId,
          );
        }
      },
    );

    it.each(
      [
        ['plain', 'completed'],
        ['json', 'completed'],
        ['plain', 'failed'],
        ['json', 'failed'],
      ].flatMap(([format, status]) =>
        ['http', 'commit'].map((phase) => [format, status, phase]),
      ),
    )(
      'retains %s %s when an older poll is delayed at %s',
      async (format, status, phase) => {
        const requestId = randomUUID();
        const key = redis.sessionKey([
          'mcp-approval-status',
          createHash('sha256').update('alice').digest('hex').slice(0, 16),
          requestId,
        ]);
        const state = {
          requestId,
          userId: 'alice',
          decision: 'approved',
          status: 'running',
          backendBaseUrl: 'http://backend:8000',
          executionId: 'fixture-execution',
          approval: {
            serverName: 'fixture',
            toolName: 'inspect',
            target: '{}',
          },
          updatedAt: 1,
        };
        if (format === 'plain')
          await client.set(key, JSON.stringify(state), 'EX', 120);
        else await client.call('JSON.SET', key, '$', JSON.stringify(state));
        const response = () =>
          ({
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis(),
            setHeader: vi.fn(),
          } as any);
        const request = { method: 'GET', query: { requestId } } as any;
        const old = response();
        const fresh = response();
        let releaseOld!: (response: Response) => void;
        let started!: () => void;
        const entered = new Promise<void>((resolve) => {
          started = resolve;
        });
        let releaseSnapshot!: () => void;
        const snapshotReleased = new Promise<void>((resolve) => {
          releaseSnapshot = resolve;
        });
        let snapshotHeld = false;
        const evaluate = client.eval.bind(client);
        const snapshot = vi
          .spyOn(client, 'eval')
          .mockImplementation(async (...args: any[]) => {
            const result = await evaluate(
              ...(args as Parameters<typeof client.eval>),
            );
            if (
              phase === 'commit' &&
              !snapshotHeld &&
              args[2] === key &&
              String(args[0]).includes('return {kind, raw}')
            ) {
              snapshotHeld = true;
              started();
              await snapshotReleased;
            }
            return result;
          });
        vi.mocked(fetchStatus).mockReset();
        vi.mocked(fetchStatus)
          .mockImplementationOnce(() => {
            if (phase === 'commit')
              return Promise.resolve(Response.json({ status: 'running' }));
            started();
            return new Promise<Response>((resolve) => {
              releaseOld = resolve;
            });
          })
          .mockResolvedValueOnce(
            Response.json({
              status,
              ...(status === 'completed'
                ? { result: { content: 'pod-a Running' } }
                : {}),
              error: status === 'failed' ? 'Fixture failure' : undefined,
            }),
          );
        const log = vi.spyOn(console, 'info').mockImplementation(() => {});
        const pending = handler(request, old);
        try {
          await entered;
          await handler(request, fresh);
          expect(fresh.json).toHaveBeenCalledWith(
            expect.objectContaining({ status }),
          );
          releaseOld?.(Response.json({ status: 'running' }));
          releaseSnapshot();
          await pending;
          expect(old.json).toHaveBeenCalledWith(
            expect.objectContaining({ status }),
          );
          expect(await redis.jsonGet(key)).toMatchObject({
            status,
            resultLogged: true,
            ...(status === 'completed'
              ? { result: { content: 'pod-a Running' } }
              : {}),
            ...(status === 'failed' ? { error: 'Fixture failure' } : {}),
          });
          const later = response();
          await handler(request, later);
          expect(later.json).toHaveBeenCalledWith(
            expect.objectContaining({ status }),
          );
          expect(fetchStatus).toHaveBeenCalledTimes(2);
          expect(log).toHaveBeenCalledTimes(1);
          expect(snapshotHeld).toBe(phase === 'commit');
        } finally {
          releaseOld?.(Response.json({ status: 'running' }));
          releaseSnapshot();
          await pending;
          snapshot.mockRestore();
          log.mockRestore();
          await client.del(key);
        }
      },
    );
  },
);
