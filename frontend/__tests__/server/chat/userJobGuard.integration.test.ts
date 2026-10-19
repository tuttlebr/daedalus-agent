import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'active chat limits with real Redis',
  () => {
    let client: any;
    let guard: typeof import('@/server/chat/userJobGuard');
    let queue: typeof import('@/server/chat/streamQueue');
    const user = `concurrent-chats-${process.pid}-${Date.now()}`;
    const keys = new Set<string>();

    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('A disposable REDIS_URL is required');
      guard = await import('@/server/chat/userJobGuard');
      queue = await import('@/server/chat/streamQueue');
      client = (await import('@/server/session/redis')).getRedis();
      if (client.status === 'wait') await client.connect();
      keys.add(guard.userJobGuardKey(user));
      keys.add(guard.userJobGuardKey(`${user}-other`));
    });

    beforeEach(async () => {
      await client.del(...keys);
    });

    afterAll(async () => {
      if (client) {
        await client.del(...keys);
        client.disconnect();
      }
    });

    it('admits exactly five simultaneous submissions and keeps other users independent', async () => {
      const admitted = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          guard.acquireUserJobGuard(user, `job-${index}`, client),
        ),
      );
      expect(admitted.filter(Boolean)).toHaveLength(5);
      expect(await client.zcard(guard.userJobGuardKey(user))).toBe(5);
      expect(await guard.acquireUserJobGuard(user, 'job-sixth', client)).toBe(
        false,
      );
      expect(
        await guard.acquireUserJobGuard(`${user}-other`, 'job-other', client),
      ).toBe(true);
      // Retrying one accepted reservation does not count twice.
      expect(await guard.acquireUserJobGuard(user, 'job-0', client)).toBe(true);
      expect(await client.zcard(guard.userJobGuardKey(user))).toBe(5);
    });

    it('releases only the finished job and admits a replacement immediately', async () => {
      for (let index = 0; index < 5; index += 1) {
        expect(
          await guard.acquireUserJobGuard(user, `job-${index}`, client),
        ).toBe(true);
      }
      await guard.releaseUserJobGuard(`${user}-other`, 'job-0', client);
      expect(
        await guard.acquireUserJobGuard(user, 'job-replacement', client),
      ).toBe(false);
      await guard.releaseUserJobGuard(user, 'job-0', client);
      expect(
        await guard.acquireUserJobGuard(user, 'job-replacement', client),
      ).toBe(true);
      await guard.releaseUserJobGuard(user, 'job-0', client);
      expect(await client.zcard(guard.userJobGuardKey(user))).toBe(5);
    });

    it('expires an abandoned reservation without expiring other jobs', async () => {
      const key = guard.userJobGuardKey(user);
      for (let index = 0; index < 5; index += 1) {
        await guard.acquireUserJobGuard(user, `job-${index}`, client);
      }
      await client.zadd(key, 0, 'job-0');
      expect(
        await guard.acquireUserJobGuard(user, 'job-replacement', client),
      ).toBe(true);
      expect(await client.zscore(key, 'job-0')).toBeNull();
      expect(await client.zcard(key)).toBe(5);
    });

    it('keeps a submission slot provisional until it is confirmed', async () => {
      const key = guard.userJobGuardKey(user);
      for (let index = 0; index < 4; index += 1) {
        await guard.acquireUserJobGuard(user, `job-${index}`, client);
      }
      expect(
        await guard.acquireUserJobGuard(user, 'job-submitting', client, 120),
      ).toBe(true);
      // Scores come from the Redis clock; compare them with each other.
      const confirmed = Number(await client.zscore(key, 'job-0'));
      const provisional = Number(await client.zscore(key, 'job-submitting'));
      expect(confirmed - provisional).toBeGreaterThan(7_000_000);
      // A short reservation never shortens the slots of other jobs.
      expect(await client.ttl(key)).toBeGreaterThan(7000);
      expect(await guard.acquireUserJobGuard(user, 'job-sixth', client)).toBe(
        false,
      );

      expect(
        await guard.confirmUserJobGuard(user, 'job-submitting', client),
      ).toBe(true);
      expect(
        Number(await client.zscore(key, 'job-submitting')) - provisional,
      ).toBeGreaterThan(7_000_000);
      expect(await client.zcard(key)).toBe(5);
    });

    it('frees an unconfirmed slot when its reservation lapses', async () => {
      const key = guard.userJobGuardKey(user);
      for (let index = 0; index < 4; index += 1) {
        await guard.acquireUserJobGuard(user, `job-${index}`, client);
      }
      await guard.acquireUserJobGuard(user, 'job-died', client, 120);
      // The submitting process died; its reservation reaches its deadline.
      await client.zadd(key, 'XX', 1, 'job-died');
      expect(
        await guard.acquireUserJobGuard(user, 'job-next', client, 120),
      ).toBe(true);
      expect(await client.zscore(key, 'job-died')).toBeNull();
      // A released or lapsed reservation can no longer be confirmed.
      expect(await guard.confirmUserJobGuard(user, 'job-died', client)).toBe(
        false,
      );
      expect(await client.zcard(key)).toBe(5);
    });

    it('renews only the lease owner and never restores a released slot after a late heartbeat', async () => {
      const jobId = `${user}-heartbeat`;
      const key = guard.userJobGuardKey(user);
      keys.add(queue.streamLeaseKey(jobId));
      await guard.acquireUserJobGuard(user, jobId, client);
      await client.zadd(key, 0, jobId);
      expect(
        await queue.acquireStreamLeaseSnapshot(jobId, 'owner', 30000, client),
      ).not.toBeNull();
      expect(
        await queue.renewStreamLease(
          jobId,
          'foreign',
          30000,
          client,
          undefined,
          key,
        ),
      ).toBe(false);
      expect(Number(await client.zscore(key, jobId))).toBe(0);
      expect(
        await queue.renewStreamLease(
          jobId,
          'owner',
          30000,
          client,
          undefined,
          key,
        ),
      ).toBe(true);
      expect(Number(await client.zscore(key, jobId))).toBeGreaterThan(
        Date.now(),
      );
      await guard.releaseUserJobGuard(user, jobId, client);
      await queue.renewStreamLease(
        jobId,
        'owner',
        30000,
        client,
        undefined,
        key,
      );
      expect(await client.zscore(key, jobId)).toBeNull();
    });
  },
);
