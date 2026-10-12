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

    it('renews only the lease owner and never restores a released slot after a late heartbeat', async () => {
      const jobId = `${user}-heartbeat`;
      const key = guard.userJobGuardKey(user);
      keys.add(queue.streamLeaseKey(jobId));
      await guard.acquireUserJobGuard(user, jobId, client);
      await client.zadd(key, 0, jobId);
      expect(
        await queue.acquireStreamLease(jobId, 'owner', 30000, client),
      ).toBe(true);
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
