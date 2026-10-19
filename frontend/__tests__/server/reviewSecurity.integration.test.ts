// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

    // Every submission reserves its conversation; an owned history must not be
    // resent and rewritten unchanged on the chat submission path.
    it('reserves an owned conversation without rewriting it', async () => {
      const id = `${prefix}-owned`;
      const ck = key('conversation', id);
      const evaluate = vi.spyOn(client, 'eval');
      const saves = () =>
        evaluate.mock.calls.filter(([script]) =>
          String(script).includes('SAVE_OWNED_CONVERSATION'),
        ).length;
      try {
        const created = await store.reserveConversationForUser(user, id);
        expect(saves()).toBe(1);
        const reserved = await store.reserveConversationForUser(user, id);
        expect(reserved).toEqual(created);
        expect(await redis.jsonGet(ck)).toEqual(created);
        expect(saves()).toBe(1);
        await expect(
          store.reserveConversationForUser(attacker, id),
        ).rejects.toMatchObject({ reason: 'forbidden' });
      } finally {
        evaluate.mockRestore();
      }
    });

    for (const json of [false, true]) {
      it(`reserves an owned ${
        json ? 'RedisJSON' : 'string'
      } conversation without rewriting its history`, async () => {
        const id = `${prefix}-owned-${json}`;
        const ck = key('conversation', id);
        const owned = {
          id,
          ownerId: user,
          name: 'Owned',
          messages: [{ role: 'user', content: 'Owned history '.repeat(100) }],
          updatedAt: 3,
        };
        if (json) await client.call('JSON.SET', ck, '$', JSON.stringify(owned));
        else await client.set(ck, JSON.stringify(owned));
        await client.sadd(key('user', user, 'conversations'), id);
        const evaluate = vi.spyOn(client, 'eval');
        try {
          expect(await store.reserveConversationForUser(user, id)).toEqual(
            owned,
          );
          // Each chat turn reserves its conversation; an unchanged owned
          // record must not be copied back through Redis.
          expect(
            evaluate.mock.calls.filter(([script]) =>
              String(script).includes('SAVE_OWNED_CONVERSATION'),
            ),
          ).toEqual([]);
        } finally {
          evaluate.mockRestore();
        }
        await client.sadd(key('user', attacker, 'conversations'), id);
        await expect(
          store.reserveConversationForUser(attacker, id),
        ).rejects.toMatchObject({ reason: 'forbidden' });
        // An expiring record still takes the write that makes it durable.
        await client.expire(ck, 600);
        expect(await store.reserveConversationForUser(user, id)).toEqual(owned);
        expect(await client.ttl(ck)).toBe(-1);
        expect(await redis.jsonGet(ck)).toEqual(owned);
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
      expect(results.filter((result) => result.status === 'rejected')).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ reason: 'forbidden' }),
        }),
      ]);
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
      expect(
        JSON.parse((await client.get(state.finalizationJournalKey(jobId)))!),
      ).toMatchObject({
        state: 'completed',
        conversationSuppressedAt: expect.any(Number),
      });
      expect(await resumePendingFinalization(jobId)).toBe('completed');
      expect(await redis.jsonGet(ck)).toEqual(original);
    });

    it('initializes and repairs counter TTLs atomically without extending ordinary fixed windows', async () => {
      const {
        confirmFailedAttempt,
        incrementExpiringCounter,
        reserveLimitedAttempt,
      } = await import('@/server/redisCounter');
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
      // An exhausted counter without an expiry is repaired to the lockout.
      expect(await reserveLimitedAttempt([{ key: ck, limit: 3 }], 60, 30)).toBe(
        30,
      );
      expect(await client.ttl(ck)).toBe(30);
      expect(await reserveLimitedAttempt([{ key: ck, limit: 4 }], 60, 30)).toBe(
        0,
      );
      expect(await client.ttl(ck)).toBe(30);
      await confirmFailedAttempt([{ key: ck, limit: 4 }], 120);
      expect(await client.get(ck)).toBe('4');
      expect(await client.ttl(ck)).toBe(120);
    });
  },
);
