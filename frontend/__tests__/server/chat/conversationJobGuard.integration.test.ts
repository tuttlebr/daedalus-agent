import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The unit suite emulates these scripts in JavaScript. Run the real Lua so the
// compare-and-set and ownership checks cannot drift from their emulation.
describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'one active response per conversation with real Redis',
  () => {
    let client: any;
    let guard: typeof import('@/server/chat/conversationJobGuard');
    const user = `conversation-guard-${process.pid}-${Date.now()}`;
    const conversation = 'conversation:1';
    let key: string;

    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('A disposable REDIS_URL is required');
      guard = await import('@/server/chat/conversationJobGuard');
      client = (await import('@/server/session/redis')).getRedis();
      if (client.status === 'wait') await client.connect();
      key = guard.conversationJobGuardKey(user, conversation);
    });

    beforeEach(async () => {
      await client.del(key);
    });

    afterAll(async () => {
      if (client) {
        await client.del(key);
        client.disconnect();
      }
    });

    it('admits one of many simultaneous jobs and reports the active owner', async () => {
      const attempts = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          guard.acquireConversationJobGuard(
            user,
            conversation,
            `job-${index}`,
            client,
          ),
        ),
      );
      const winners = attempts.filter((attempt) => attempt.acquired);
      expect(winners).toHaveLength(1);
      const winner = winners[0] as Extract<
        (typeof attempts)[number],
        { acquired: true }
      >;
      for (const attempt of attempts.filter((value) => !value.acquired)) {
        expect(attempt).toMatchObject({
          acquired: false,
          current: { jobId: winner.guard.jobId },
          currentSerialized: await client.get(key),
        });
      }
      expect(await client.ttl(key)).toBeGreaterThan(7190);
    });

    it('replaces only the exact stale owner snapshot', async () => {
      const first = await guard.acquireConversationJobGuard(
        user,
        conversation,
        'abandoned',
        client,
        1_000,
      );
      expect(first.acquired).toBe(true);
      const blocked = await guard.acquireConversationJobGuard(
        user,
        conversation,
        'next',
        client,
      );
      if (blocked.acquired) throw new Error('expected an active owner');
      expect(guard.isConversationJobInitializationStale(blocked.current!)).toBe(
        true,
      );

      const [one, two] = await Promise.all([
        guard.replaceStaleConversationJobGuard(
          user,
          conversation,
          blocked.currentSerialized!,
          'replacement-a',
          client,
        ),
        guard.replaceStaleConversationJobGuard(
          user,
          conversation,
          blocked.currentSerialized!,
          'replacement-b',
          client,
        ),
      ]);
      expect([one, two].filter(Boolean)).toHaveLength(1);
      const stored = JSON.parse(await client.get(key));
      expect(stored.jobId).toBe((one ?? two)!.jobId);
      expect(await client.ttl(key)).toBeGreaterThan(7190);
    });

    it('releases only the matching owner and tolerates malformed records', async () => {
      await guard.acquireConversationJobGuard(
        user,
        conversation,
        'job-1',
        client,
      );
      expect(
        await guard.releaseConversationJobGuard(
          user,
          conversation,
          'job-other',
          client,
        ),
      ).toBe(false);
      expect(
        await guard.releaseConversationJobGuard(
          `${user}-other`,
          conversation,
          'job-1',
          client,
        ),
      ).toBe(false);
      expect(await client.exists(key)).toBe(1);
      expect(
        await guard.releaseConversationJobGuard(
          user,
          conversation,
          'job-1',
          client,
        ),
      ).toBe(true);
      expect(await client.exists(key)).toBe(0);

      await client.set(key, 'not-json');
      expect(
        await guard.releaseConversationJobGuard(
          user,
          conversation,
          'job-1',
          client,
        ),
      ).toBe(false);
      await expect(
        guard.acquireConversationJobGuard(user, conversation, 'job-2', client),
      ).resolves.toEqual({
        acquired: false,
        current: null,
        currentSerialized: 'not-json',
      });
    });
  },
);
