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

    afterAll(() => client?.disconnect());

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
