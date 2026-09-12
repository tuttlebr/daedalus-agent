// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'review security regressions with disposable Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let store: typeof import('@/server/session/conversationStore');
    let client: ReturnType<typeof redis.getRedis>;
    const prefix = `security-${randomUUID()}`;
    const user = `${prefix}-owner`;
    const attacker = `${prefix}-other`;
    const tracked = new Set<string>();
    const key = (...parts: string[]) => {
      const value = redis.sessionKey(parts);
      tracked.add(value);
      return value;
    };

    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('A disposable REDIS_URL is required');
      redis = await import('@/server/session/redis');
      store = await import('@/server/session/conversationStore');
      client = redis.getRedis();
      await client.ping();
      key('user', user, 'conversations');
      key('user', attacker, 'conversations');
    });
    afterAll(async () => {
      if (client) {
        if (tracked.size) await client.del(...tracked);
        client.disconnect();
      }
    });

    for (const json of [false, true]) {
      it(`denies foreign claims and writes while lazily binding legacy ${
        json ? 'RedisJSON' : 'string'
      } ownership`, async () => {
        const id = `${prefix}-legacy-${json}`;
        const ck = key('conversation', id);
        const original = {
          id,
          messages: [{ role: 'assistant', content: 'Private original' }],
          updatedAt: 5,
        };
        if (json)
          await client.call('JSON.SET', ck, '$', JSON.stringify(original));
        else await client.set(ck, JSON.stringify(original));
        await client.sadd(key('user', user, 'conversations'), id);
        await expect(
          store.reserveConversationForUser(attacker, id),
        ).rejects.toMatchObject({ reason: 'forbidden' });
        await expect(
          store.saveConversationForUser(
            attacker,
            id,
            () => ({ messages: ['replacement'] }),
            true,
          ),
        ).rejects.toMatchObject({ reason: 'forbidden' });
        expect(await redis.jsonGet(ck)).toEqual(original);
        const adopted = await store.reserveConversationForUser(user, id);
        expect(adopted.ownerId).toBe(user);
        expect(adopted.messages).toEqual(original.messages);
        await client.sadd(key('user', attacker, 'conversations'), id);
        await expect(
          store.readConversationForUser(attacker, id),
        ).rejects.toMatchObject({ reason: 'forbidden' });
        const { deleteConversationForUser } = await import(
          '@/server/session/conversationDeletion'
        );
        key('user', attacker, 'conversationHistory');
        key('user', attacker, 'selectedConversation');
        expect(await deleteConversationForUser(attacker, id)).toBe(false);
        expect((await redis.jsonGet(ck)).ownerId).toBe(user);
      });
    }

    it('allows exactly one owner when distinct users concurrently create the same ID', async () => {
      const id = `${prefix}-claim`;
      key('conversation', id);
      const results = await Promise.allSettled([
        store.reserveConversationForUser(user, id),
        store.reserveConversationForUser(attacker, id),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      const record = await redis.jsonGet(key('conversation', id));
      const loser = record.ownerId === user ? attacker : user;
      expect(
        await client.sismember(key('user', loser, 'conversations'), id),
      ).toBe(0);
    });

    it('does not resurrect a deleted record from finalization or let old membership claim a new owner record', async () => {
      const id = `${prefix}-deleted`;
      const ck = key('conversation', id);
      await store.reserveConversationForUser(user, id);
      await client.del(ck); // TTL expiry leaves historical membership behind.
      await expect(
        store.saveConversationForUser(user, id, () => ({ messages: ['late'] })),
      ).rejects.toMatchObject({ reason: 'forbidden' });
      await store.reserveConversationForUser(attacker, id);
      await expect(
        store.readConversationForUser(user, id),
      ).rejects.toMatchObject({ reason: 'forbidden' });
      await expect(
        store.saveConversationForUser(user, id, () => ({ messages: ['late'] })),
      ).rejects.toMatchObject({ reason: 'forbidden' });
    });

    it('retries concurrent owner edits without losing acknowledged changes or empty arrays', async () => {
      const id = `${prefix}-updates`;
      key('conversation', id);
      await store.reserveConversationForUser(user, id);
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          store.saveConversationForUser(user, id, (current) => ({
            ...current,
            messages: [...(current?.messages ?? []), { id: index, steps: [] }],
          })),
        ),
      );
      const record = await store.readConversationForUser(user, id);
      expect(record?.messages).toHaveLength(12);
      expect(
        new Set(record?.messages.map((message: any) => message.id)).size,
      ).toBe(12);
      expect(
        record?.messages.every((message: any) => Array.isArray(message.steps)),
      ).toBe(true);
    });

    it('suppresses an unowned legacy job finalization without retrying forever or overwriting the owner', async () => {
      const id = `${prefix}-late-job`;
      const ck = key('conversation', id);
      await store.reserveConversationForUser(user, id);
      await store.saveConversationForUser(user, id, (current) => ({
        ...current,
        messages: [{ role: 'user', content: 'Keep my original' }],
      }));
      const original = await redis.jsonGet(ck);
      const jobId = `${prefix}-unowned-job`;
      await redis.jsonSetWithExpiry(
        key('async-job-status', jobId),
        {
          jobId,
          status: 'streaming',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          conversationId: id,
        },
        120,
      );
      const state = await import('@/server/chat/jobState');
      const { finalizeError, resumePendingFinalization } = await import(
        '@/server/chat/finalization'
      );
      tracked.add(state.finalizationJournalKey(jobId));
      tracked.add(state.finalizerLockKey(jobId));
      tracked.add(state.abortKey(jobId));
      await finalizeError(
        jobId,
        {
          jobId,
          userId: attacker,
          conversationId: id,
          messages: [{ role: 'user', content: 'Replace owner history' }],
        } as any,
        'Interrupted legacy job',
      );
      expect(await redis.jsonGet(ck)).toEqual(original);
      expect(await state.getFinalizationJournal(jobId)).toMatchObject({
        state: 'completed',
        conversationSuppressedAt: expect.any(Number),
      });
      expect(await resumePendingFinalization(jobId)).toBe('completed');
      expect(await redis.jsonGet(ck)).toEqual(original);
    });

    it('initializes and repairs counter TTLs atomically without extending ordinary fixed windows', async () => {
      const { incrementExpiringCounter, readExpiringCounter } = await import(
        '@/server/redisCounter'
      );
      const ck = key(prefix, 'counter');
      const first = await incrementExpiringCounter(ck, 60);
      expect(first).toEqual([1, 60]);
      await client.expire(ck, 12);
      expect((await incrementExpiringCounter(ck, 60))[1]).toBeLessThanOrEqual(
        12,
      );
      await client.persist(ck);
      expect(await client.ttl(ck)).toBe(-1);
      expect(await incrementExpiringCounter(ck, 60)).toEqual([3, 60]);
      await client.persist(ck);
      expect(await readExpiringCounter(ck, 30)).toEqual([3, 30]);
      expect(await incrementExpiringCounter(ck, 60, 4, 120)).toEqual([4, 120]);
    });
  },
);
