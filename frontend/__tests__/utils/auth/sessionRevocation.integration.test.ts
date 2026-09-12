// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const cookie = vi.hoisted(() => ({ sid: '' }));
vi.mock('@/server/session/_utils', () => ({
  getOrSetSessionId: () => cookie.sid,
  readSessionId: () => cookie.sid,
  clearSessionCookie: vi.fn(),
  rotateSessionId: vi.fn(),
}));

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'configured session eligibility in real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let auth: typeof import('@/utils/auth/session');
    let ws: typeof import('../../../ws-server');
    const keys: string[] = [];
    const configured = `session-configured-${process.pid}`;
    const removed = `session-removed-${process.pid}`;
    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('Disposable REDIS_URL required');
      vi.stubEnv('AUTH_USER_1_USERNAME', configured);
      vi.stubEnv('AUTH_USER_1_PASSWORD', 'test-password-only');
      vi.stubEnv('AUTH_USER_2_USERNAME', '');
      redis = await import('@/server/session/redis');
      auth = await import('@/utils/auth/session');
      ws = await import('../../../ws-server');
      await redis.getRedis().ping();
    });
    afterAll(async () => {
      vi.unstubAllEnvs();
      if (redis) {
        if (keys.length) await redis.getRedis().del(...keys);
        redis.getRedis().disconnect();
      }
    });

    async function seed(username: string, json: boolean, elapsed: number) {
      cookie.sid = `session-eligibility-${process.pid}-${keys.length}`;
      const key = redis.sessionKey(['auth-session', cookie.sid]);
      keys.push(key);
      const session = {
        username,
        userId: username,
        name: username,
        loginTime: 1,
        lastActivity: Date.now() - elapsed,
      };
      const client = redis.getRedis();
      if (json)
        await client.call('JSON.SET', key, '$', JSON.stringify(session));
      else await client.set(key, JSON.stringify(session));
      await client.expire(key, 120);
      return { key, session };
    }

    for (const json of [false, true]) {
      for (const elapsed of [0, 60_001]) {
        it(`revokes removed API sessions before refresh (JSON=${json}, elapsed=${elapsed})`, async () => {
          const { key } = await seed(removed, json, elapsed);
          expect(await auth.getSession({} as any, {} as any)).toBeNull();
          expect(await redis.getRedis().exists(key)).toBe(0);
        });
      }
      it(`rejects removed WebSocket sessions and retains configured sessions (JSON=${json})`, async () => {
        const old = await seed(removed, json, 0);
        expect(
          await ws.readConfiguredSession(redis.getRedis(), cookie.sid),
        ).toBeNull();
        expect(await redis.getRedis().exists(old.key)).toBe(0);
        const active = await seed(configured, json, 60_001);
        expect(
          await ws.readConfiguredSession(redis.getRedis(), cookie.sid),
        ).toEqual(active.session);
        expect(await auth.getSession({} as any, {} as any)).toMatchObject({
          username: configured,
        });
        expect(await redis.getRedis().ttl(active.key)).toBeGreaterThan(86_390);
        // Eligibility does not initialize or write a persisted user record.
        expect(
          await redis.getRedis().exists(redis.sessionKey(['user', configured])),
        ).toBe(0);
      });
    }
  },
);
