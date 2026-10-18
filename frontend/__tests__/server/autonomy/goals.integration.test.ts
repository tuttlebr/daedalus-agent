// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'concurrent goals with real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let store: typeof import('@/server/autonomy/store');
    const users: string[] = [];
    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('Disposable REDIS_URL required');
      redis = await import('@/server/session/redis');
      store = await import('@/server/autonomy/store');
      await redis.getRedis().ping();
    });
    afterAll(async () => {
      if (redis) {
        for (const user of users)
          await redis
            .getRedis()
            .del(
              ...['goals', 'config', 'runs', 'cancel:run-a', 'queue'].map(
                (name) => redis.sessionKey(['autonomy', user, name]),
              ),
            );
        redis.getRedis().disconnect();
      }
    });
    it.each(['single', 'batch'])(
      'enforces queue capacity for concurrent %s submissions',
      async (mode) => {
        const user = `queue-review-${mode}-${process.pid}-${Date.now()}`;
        users.push(user);
        const key = redis.sessionKey(['autonomy', user, 'queue']);
        const count = mode === 'single' ? 99 : 97;
        const initial = Array.from({ length: count }, (_, i) =>
          JSON.stringify({ id: `existing-${i}` }),
        );
        await redis.getRedis().rpush(key, ...initial);
        await store.importGoals(user, [
          { title: 'First', priority: 1 },
          { title: 'Second', priority: 2 },
        ]);
        const enqueue = () =>
          mode === 'single'
            ? store.enqueueRun(user, { prompt: 'review' })
            : store.enqueueAllActiveGoals(user);
        const client = redis.getRedis();
        const llen = client.llen.bind(client);
        let release!: () => void;
        const bothRead = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reads = 0;
        const spy = vi
          .spyOn(client, 'llen')
          .mockImplementation(async (...args) => {
            const depth = await llen(...args);
            if (++reads === 2) release();
            await bothRead;
            return depth;
          });
        const outcomes = await Promise.allSettled([
          enqueue(),
          enqueue(),
        ]).finally(() => spy.mockRestore());
        expect(
          outcomes.filter((value) => value.status === 'fulfilled'),
        ).toHaveLength(1);
        expect(
          outcomes.find((value) => value.status === 'rejected'),
        ).toMatchObject({ reason: expect.any(store.QueueFullError) });
        const queued = await redis.getRedis().lrange(key, 0, -1);
        expect(queued).toHaveLength(mode === 'single' ? 100 : 99);
        expect(queued.slice(mode === 'single' ? 1 : 2)).toEqual(initial);
        if (mode === 'batch') {
          const goals = await store.listGoals(user);
          // LPUSH keeps the highest-priority goal next for the worker's RPOP.
          expect(
            queued.slice(0, 2).map((value) => JSON.parse(value).goalId),
          ).toEqual([goals[1].id, goals[0].id]);
        }
      },
    );

    it('preserves concurrent config fields and unrelated run updates', async () => {
      const user = `implementation-config-${process.pid}-${Date.now()}`;
      users.push(user);
      await Promise.all([
        store.getConfig(user),
        store.saveConfig(user, { enabled: false }),
        store.saveConfig(user, { intervalSeconds: 900 }),
      ]);
      expect(await store.getConfig(user)).toMatchObject({
        enabled: false,
        intervalSeconds: 900,
      });
      const key = redis.sessionKey(['autonomy', user, 'runs']);
      await redis.jsonSet(key, '$', [
        { id: 'run-a', status: 'running' },
        { id: 'run-b', status: 'running' },
      ]);
      const { updateJsonAtomically } = await import('@/server/atomicJson');
      await Promise.all([
        store.cancelRun(user, 'run-a'),
        updateJsonAtomically<any[]>(key, (runs) =>
          runs!.map((run) =>
            run.id === 'run-b' ? { ...run, status: 'completed' } : run,
          ),
        ),
      ]);
      expect(await store.listRuns(user)).toEqual([
        expect.objectContaining({ id: 'run-a', status: 'cancelled' }),
        expect.objectContaining({ id: 'run-b', status: 'completed' }),
      ]);
    });
    it.each(['string', 'RedisJSON'])(
      'preserves acknowledged mutations using %s',
      async (kind) => {
        const user = `implementation-goals-${kind}-${
          process.pid
        }-${Date.now()}`;
        users.push(user);
        const key = redis.sessionKey(['autonomy', user, 'goals']);
        if (kind === 'string') await redis.getRedis().set(key, '[]');
        else await redis.getRedis().call('JSON.SET', key, '$', '[]');
        const created = await Promise.all(
          Array.from({ length: 10 }, (_, n) =>
            store.createGoal(user, { title: `Goal ${n}`, description: '' }),
          ),
        );
        expect((await store.listGoals(user)).map((g) => g.id).sort()).toEqual(
          created.map((g) => g.id).sort(),
        );
        await Promise.all([
          store.mutateGoals(user, (goals) =>
            goals.filter((g) => g.id !== created[0].id),
          ),
          store.mutateGoals(user, (goals) =>
            goals.map((g) =>
              g.id === created[1].id ? { ...g, title: 'Edited' } : g,
            ),
          ),
          store.importGoals(
            user,
            [{ id: 'imported', title: 'Imported' }],
            'append',
          ),
        ]);
        const goals = await store.listGoals(user);
        expect(goals).toHaveLength(10);
        expect(goals.some((g) => g.id === created[0].id)).toBe(false);
        expect(goals.find((g) => g.id === created[1].id)?.title).toBe('Edited');
        expect(goals.find((g) => g.id === 'goal_imported')).toBeDefined();
        expect(await redis.getRedis().type(key)).toBe(
          kind === 'string' ? 'string' : 'ReJSON-RL',
        );
        await store.importGoals(user, [{ title: '' }], 'replace');
        expect(await store.listGoals(user)).toEqual(goals);
      },
    );
  },
);
