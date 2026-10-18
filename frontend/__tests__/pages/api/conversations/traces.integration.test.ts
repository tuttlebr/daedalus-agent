// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ username: '' }));
vi.mock('@/utils/auth/session', () => ({ getSession: async () => session }));

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'conversation trace export with real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let client: ReturnType<typeof redis.getRedis>;
    const keys = new Set<string>();

    beforeAll(async () => {
      if (!process.env.REDIS_URL) throw new Error('Disposable Redis required');
      redis = await import('@/server/session/redis');
      client = redis.getRedis();
      await client.ping();
    });

    afterAll(async () => {
      if (client) {
        if (keys.size) await client.del(...keys);
        client.disconnect();
      }
    });

    async function exportTraces(conversationId: string) {
      const handler = (await import('@/pages/api/conversations/[id]/traces'))
        .default;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
        setHeader: vi.fn(),
      };
      await handler(
        { method: 'GET', query: { id: conversationId } } as any,
        res as any,
      );
      expect(res.status).toHaveBeenCalledWith(200);
      return String(res.send.mock.calls[0][0])
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }

    it('includes the running response steps recorded by the stream worker', async () => {
      const { saveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      const { acquireConversationJobGuard, conversationJobGuardKey } =
        await import('@/server/chat/conversationJobGuard');
      const streamState = await import('@/server/chat/streamState');
      const user = `trace-${randomUUID()}`;
      const conversationId = randomUUID();
      const jobId = randomUUID();
      session.username = user;
      for (const key of [
        redis.sessionKey(['conversation', conversationId]),
        redis.sessionKey(['user', user, 'conversations']),
        redis.sessionKey(['async-job-request', jobId]),
        redis.sessionKey(['async-job-status', jobId]),
        conversationJobGuardKey(user, conversationId),
        streamState.streamStepsKey(jobId),
      ])
        keys.add(key);

      const savedStep = { payload: { UUID: 'saved', event_type: 'TOOL_END' } };
      await saveConversationForUser(
        user,
        conversationId,
        () => ({
          id: conversationId,
          name: 'Running research',
          messages: [
            { id: 'user-1', role: 'user', content: 'Research' },
            {
              id: 'assistant-0',
              role: 'assistant',
              content: 'Earlier answer',
              intermediateSteps: [savedStep],
            },
          ],
        }),
        true,
      );
      // The submission route records these before the worker starts.
      keys.add(
        redis.sessionKey([
          'streaming',
          'user',
          user,
          'conversation',
          conversationId,
        ]),
      );
      await redis.setStreamingState(user, conversationId, jobId);
      await acquireConversationJobGuard(user, conversationId, jobId, client);
      await redis.jsonSetWithExpiry(
        redis.sessionKey(['async-job-request', jobId]),
        { jobId, userId: user, conversationId, messages: [] },
        120,
      );
      await redis.jsonSetWithExpiry(
        redis.sessionKey(['async-job-status', jobId]),
        { jobId, status: 'streaming', turnId: 'turn-live', createdAt: 1 },
        120,
      );
      const liveSteps = [
        { payload: { UUID: 'live-search', event_type: 'TOOL_START' } },
        { payload: { UUID: 'live-search', event_type: 'TOOL_END' } },
      ];
      await streamState.appendStreamSteps(jobId, liveSteps, 0);

      const lines = await exportTraces(conversationId);

      expect(lines.map((line) => [line.payload.UUID, line.live])).toEqual([
        ['saved', false],
        ['live-search', true],
        ['live-search', true],
      ]);
      expect(lines[1]).toMatchObject({
        job_id: jobId,
        turn_id: 'turn-live',
        conversation_name: 'Running research',
      });

      // A finalized response is exported only from its saved conversation.
      await redis.jsonSetWithExpiry(
        redis.sessionKey(['async-job-status', jobId]),
        { jobId, status: 'completed', finalizedAt: 2, createdAt: 1 },
        120,
      );
      expect((await exportTraces(conversationId)).map((l) => l.live)).toEqual([
        false,
      ]);
    });

    it("does not export another user's running job through a forged guard", async () => {
      const { saveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      const { conversationJobGuardKey } = await import(
        '@/server/chat/conversationJobGuard'
      );
      const streamState = await import('@/server/chat/streamState');
      const user = `trace-${randomUUID()}`;
      const conversationId = randomUUID();
      const jobId = randomUUID();
      session.username = user;
      const guardKey = conversationJobGuardKey(user, conversationId);
      for (const key of [
        redis.sessionKey(['conversation', conversationId]),
        redis.sessionKey(['user', user, 'conversations']),
        redis.sessionKey(['async-job-request', jobId]),
        guardKey,
        streamState.streamStepsKey(jobId),
      ])
        keys.add(key);
      await saveConversationForUser(
        user,
        conversationId,
        () => ({ id: conversationId, name: 'Mine', messages: [] }),
        true,
      );
      await client.set(
        guardKey,
        JSON.stringify({
          version: 1,
          userId: user,
          conversationId,
          jobId,
          acquiredAt: 1,
        }),
        'EX',
        120,
      );
      await redis.jsonSetWithExpiry(
        redis.sessionKey(['async-job-request', jobId]),
        { jobId, userId: 'someone-else', conversationId, messages: [] },
        120,
      );
      await streamState.appendStreamSteps(
        jobId,
        [{ payload: { UUID: 'private', event_type: 'TOOL_END' } }],
        0,
      );

      expect(await exportTraces(conversationId)).toEqual([]);
    });
  },
);
