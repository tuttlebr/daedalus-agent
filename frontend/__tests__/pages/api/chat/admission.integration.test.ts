// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ username: '' }));
vi.mock('@/utils/auth/session', () => ({ getSession: async () => session }));
vi.mock('@/server/chat/backendSelection', () => ({
  selectStreamBackendBaseUrl: async () => 'http://127.0.0.1:1',
}));

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'chat admission after interrupted finalization',
  () => {
    let redis: typeof import('@/server/session/redis');
    let client: ReturnType<typeof redis.getRedis>;
    const prefix = `admission-${randomUUID()}`;
    const jobs = new Set<string>();

    beforeAll(async () => {
      if (!process.env.REDIS_URL) throw new Error('Disposable Redis required');
      session.username = prefix;
      redis = await import('@/server/session/redis');
      client = redis.getRedis();
      await client.ping();
    });

    afterAll(async () => {
      if (!client) return;
      const { STREAM_QUEUE_KEY, acknowledgeStreamQueueEntry } = await import(
        '@/server/chat/streamQueue'
      );
      for (const [entryId, fields] of await client.xrange(
        STREAM_QUEUE_KEY,
        '-',
        '+',
      )) {
        const jobId = fields[fields.indexOf('jobId') + 1];
        if (jobs.has(jobId))
          await acknowledgeStreamQueueEntry({
            entryId,
            jobId,
            reclaimed: false,
          });
      }
      // Only remove this test's random namespace and allocated job records.
      for (const token of [prefix, ...jobs]) {
        let cursor = '0';
        do {
          const [next, keys] = await client.scan(
            cursor,
            'MATCH',
            `*${token}*`,
            'COUNT',
            100,
          );
          if (keys.length) await client.del(...keys);
          cursor = next;
        } while (cursor !== '0');
      }
      redis.getPublisher().disconnect();
      client.disconnect();
    });

    it('includes the recovered answer in model input and the next saved turn', async () => {
      const { reserveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      const { acquireConversationJobGuard } = await import(
        '@/server/chat/conversationJobGuard'
      );
      const { claimTerminalJobStatus } = await import('@/server/chat/jobState');
      const { finalizeError } = await import('@/server/chat/finalization');
      const { loadStreamQueuePayload } = await import(
        '@/server/chat/streamQueue'
      );
      const handler = (await import('@/pages/api/chat/async')).default;
      const previousJob = `${prefix}-previous`;
      const conversationId = `${prefix}-conversation`;
      jobs.add(previousJob);
      await reserveConversationForUser(prefix, conversationId);
      await acquireConversationJobGuard(prefix, conversationId, previousJob);
      await redis.setStreamingState(prefix, conversationId, previousJob);
      await redis.jsonSetWithExpiry(
        redis.sessionKey(['async-job-status', previousJob]),
        { jobId: previousJob, status: 'streaming', createdAt: 1 },
        120,
      );
      const firstQuestion = {
        id: 'u1',
        role: 'user',
        content: 'First question',
      };
      // Simulate a crash after claiming the outcome but before saving it.
      expect(
        await claimTerminalJobStatus(
          previousJob,
          { status: 'error', finalizedAt: 2 },
          {
            version: 1,
            state: 'pending',
            jobId: previousJob,
            finalizationId: previousJob,
            outcome: 'error',
            userId: prefix,
            finalizedAt: 2,
            conversation: {
              id: conversationId,
              name: 'Recovery',
              messages: [firstQuestion],
              assistantMessageId: 'a1',
              content: 'Recovered first answer',
              intermediateSteps: [],
              isPartial: true,
            },
          },
        ),
      ).toBe(true);

      const followUp = { id: 'u2', role: 'user', content: 'Follow up' };
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
      };
      await handler(
        {
          method: 'POST',
          headers: { cookie: 'sid=admission-test-session' },
          body: {
            conversationId,
            messages: [followUp],
            assistantMessageId: 'a2',
          },
        } as any,
        res as any,
      );
      expect(res.status).toHaveBeenCalledWith(200);
      const nextJob = res.json.mock.calls[0][0].jobId;
      jobs.add(nextJob);
      const request = await redis.jsonGet(
        redis.sessionKey(['async-job-request', nextJob]),
      );
      expect(request.messages.map((message: any) => message.id)).toEqual([
        'u1',
        'a1',
        'u2',
      ]);
      const payload = await loadStreamQueuePayload(nextJob);
      expect(
        payload?.messagesForNat.map((message: any) => message.content),
      ).toEqual([
        expect.stringContaining('[IDENTITY]'),
        'First question',
        'Recovered first answer',
        'Follow up',
      ]);
      await finalizeError(nextJob, request, 'Synthetic stop', {
        response: 'Second partial answer',
        pendingSteps: [],
        persistedStepCount: 0,
      });
      const saved = await redis.jsonGet(
        redis.sessionKey(['conversation', conversationId]),
      );
      expect(saved.messages.map((message: any) => message.id)).toEqual([
        'u1',
        'a1',
        'u2',
        'a2',
      ]);
      expect(saved.messages[1].content).toBe('Recovered first answer');
    });

    it('recovers a conversation and slot from a submission that died before queueing', async () => {
      const { reserveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      const { conversationJobGuardKey } = await import(
        '@/server/chat/conversationJobGuard'
      );
      const { acquireUserJobGuard, userJobGuardKey } = await import(
        '@/server/chat/userJobGuard'
      );
      const handler = (await import('@/pages/api/chat/async')).default;
      const deadJob = `${prefix}-dead-submission`;
      const conversationId = `${prefix}-dead-conversation`;
      jobs.add(deadJob);
      await reserveConversationForUser(prefix, conversationId);
      const acquiredAt = Date.now() - 10 * 60 * 1000;
      // What the submitting process wrote before it died: the guard, a
      // provisional slot and a provisional status, but no request or payload.
      await client.set(
        conversationJobGuardKey(prefix, conversationId),
        JSON.stringify({
          version: 1,
          userId: prefix,
          conversationId,
          jobId: deadJob,
          acquiredAt,
        }),
        'EX',
        7200,
      );
      expect(await acquireUserJobGuard(prefix, deadJob, client, 120)).toBe(
        true,
      );
      const deadStatusKey = redis.sessionKey(['async-job-status', deadJob]);
      await redis.jsonSetWithExpiry(
        deadStatusKey,
        {
          jobId: deadJob,
          status: 'pending',
          createdAt: acquiredAt,
          updatedAt: acquiredAt,
          conversationId,
        },
        120,
      );

      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
      };
      await handler(
        {
          method: 'POST',
          headers: { cookie: 'sid=admission-test-session' },
          body: {
            conversationId,
            messages: [{ id: 'u1', role: 'user', content: 'Try again' }],
          },
        } as any,
        res as any,
      );

      expect(res.status).toHaveBeenCalledWith(200);
      const nextJob = res.json.mock.calls[0][0].jobId;
      jobs.add(nextJob);
      expect(
        JSON.parse(
          (await client.get(conversationJobGuardKey(prefix, conversationId)))!,
        ).jobId,
      ).toBe(nextJob);
      expect(await client.exists(deadStatusKey)).toBe(0);
      const slots = userJobGuardKey(prefix);
      expect(await client.zscore(slots, deadJob)).toBeNull();
      expect(await client.zscore(slots, nextJob)).not.toBeNull();
      // The new job is queued with its full lifetime.
      expect(
        await client.ttl(redis.sessionKey(['async-job-status', nextJob])),
      ).toBeGreaterThan(3000);
    });
  },
);
