// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
              ...['goals', 'config', 'runs', 'cancel:run-a'].map((name) =>
                redis.sessionKey(['autonomy', user, name]),
              ),
            );
        redis.getRedis().disconnect();
      }
    });
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
