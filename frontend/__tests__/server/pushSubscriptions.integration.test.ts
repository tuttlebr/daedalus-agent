// @vitest-environment node
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const identity = vi.hoisted(() => ({ username: '' }));
vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: async () => identity,
}));

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'device registrations with real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let handler: typeof import('@/pages/api/push/subscribe').default;
    let key: string;
    const keys = {
      p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    };
    const subscription = (id: number) => ({
      endpoint: `https://fcm.googleapis.com/fcm/send/review-${id}`,
      keys,
    });
    const request = async (method: string, body: unknown) => {
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
      };
      await handler({ method, body } as any, res as any);
      return res.status.mock.calls[0][0];
    };
    beforeAll(async () => {
      if (!process.env.REDIS_URL) throw new Error('Disposable Redis required');
      vi.stubEnv('PUSH_NOTIFICATIONS_ENABLED', 'true');
      identity.username = `push-review-${randomUUID()}`;
      redis = await import('@/server/session/redis');
      key = redis.sessionKey(['user', identity.username, 'push-subscriptions']);
      handler = (await import('@/pages/api/push/subscribe')).default;
    });
    beforeEach(async () => {
      await redis.getRedis().del(key);
    });
    afterAll(async () => {
      vi.unstubAllEnvs();
      if (redis) {
        await redis.getRedis().del(key);
        redis.getRedis().disconnect();
      }
    });
    it('retains every acknowledged concurrent device registration', async () => {
      const subscriptions = Array.from({ length: 12 }, (_, i) =>
        subscription(i),
      );
      expect(
        await Promise.all(subscriptions.map((value) => request('POST', value))),
      ).toEqual(Array(12).fill(201));
      expect(
        (await redis.jsonGet(key)).map((value: any) => value.endpoint).sort(),
      ).toEqual(subscriptions.map((value) => value.endpoint).sort());
    });
    it('admits only one device when concurrent requests compete for the final slot', async () => {
      await redis.jsonSetWithExpiry(
        key,
        Array.from({ length: 19 }, (_, i) => subscription(i)),
        300,
      );
      const statuses = await Promise.all([
        request('POST', subscription(19)),
        request('POST', subscription(20)),
      ]);
      expect(statuses.sort()).toEqual([201, 409]);
      expect(await redis.jsonGet(key)).toHaveLength(20);
    });
  },
);
