// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeUsers: vi.fn(),
  verifyCredentials: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('@/utils/auth/users', () => ({
  initializeUsers: mocks.initializeUsers,
  verifyCredentials: mocks.verifyCredentials,
}));

vi.mock('@/utils/auth/session', () => ({
  createSession: mocks.createSession,
}));

function attemptKey(scope: 'pair' | 'account' | 'ip', value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `auth-login-attempts:${scope}:${digest}`;
}

function request(username: string, ip: string) {
  const req = {
    method: 'POST',
    body: { username, password: 'guess' },
    query: {},
    headers: { 'x-forwarded-for': ip, 'user-agent': 'vitest' },
    socket: { remoteAddress: '127.0.0.1' },
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
  return { req, res };
}

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'login attempt limits with real Redis',
  () => {
    let handler: typeof import('@/pages/api/auth/login').default;
    let client: any;
    const prefix = `login-${randomUUID()}`;
    const tracked = new Set<string>();
    const track = (username: string, ips: string[]) => {
      tracked.add(attemptKey('account', username.toLowerCase()));
      for (const ip of ips) {
        tracked.add(attemptKey('ip', ip));
        tracked.add(attemptKey('pair', `${username.toLowerCase()}|${ip}`));
      }
    };

    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('A disposable REDIS_URL is required');
      handler = (await import('@/pages/api/auth/login')).default;
      client = (await import('@/server/session/redis')).getRedis();
      await client.ping();
    });

    beforeEach(() => {
      vi.clearAllMocks();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mocks.initializeUsers.mockResolvedValue(undefined);
      mocks.createSession.mockResolvedValue('session');
    });

    afterAll(async () => {
      if (client) {
        if (tracked.size) await client.del(...tracked);
        client.disconnect();
      }
    });

    it('verifies no more concurrent guesses than the pair limit allows', async () => {
      const username = `${prefix}-pair`;
      const ip = '198.51.100.7';
      track(username, [ip]);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mocks.verifyCredentials.mockImplementation(async () => {
        await gate;
        return null;
      });

      const attempts = Array.from({ length: 20 }, () => request(username, ip));
      const pending = attempts.map(({ req, res }) => handler(req, res));
      await vi.waitFor(() =>
        expect(
          attempts.filter(({ res }) => res.status.mock.calls.length).length +
            mocks.verifyCredentials.mock.calls.length,
        ).toBe(20),
      );
      release();
      await Promise.all(pending);

      expect(mocks.verifyCredentials).toHaveBeenCalledTimes(5);
      const statuses = attempts.map(({ res }) => res.status.mock.calls[0][0]);
      expect(statuses.filter((status) => status === 401)).toHaveLength(5);
      expect(statuses.filter((status) => status === 429)).toHaveLength(15);
      expect(
        Number(await client.get(attemptKey('pair', `${username}|${ip}`))),
      ).toBe(5);
      expect(
        await client.ttl(attemptKey('pair', `${username}|${ip}`)),
      ).toBeGreaterThan(300);
    });

    it('bounds concurrent guesses against one account across source addresses', async () => {
      const username = `${prefix}-account`;
      const ips = Array.from(
        { length: 40 },
        (_, index) => `203.0.113.${index + 1}`,
      );
      track(username, ips);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mocks.verifyCredentials.mockImplementation(async () => {
        await gate;
        return null;
      });

      const attempts = ips.map((ip) => request(username, ip));
      const pending = attempts.map(({ req, res }) => handler(req, res));
      await vi.waitFor(() =>
        expect(
          attempts.filter(({ res }) => res.status.mock.calls.length).length +
            mocks.verifyCredentials.mock.calls.length,
        ).toBe(40),
      );
      release();
      await Promise.all(pending);

      expect(mocks.verifyCredentials).toHaveBeenCalledTimes(10);
    });

    it('does not count successful or failed-infrastructure logins as failures', async () => {
      const username = `${prefix}-success`;
      const ip = '192.0.2.44';
      track(username, [ip]);
      const pairKey = attemptKey('pair', `${username}|${ip}`);
      const accountKey = attemptKey('account', username);
      const ipKey = attemptKey('ip', ip);

      mocks.verifyCredentials.mockResolvedValue(null);
      for (let index = 0; index < 3; index += 1) {
        const { req, res } = request(username, ip);
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(401);
      }

      mocks.verifyCredentials.mockRejectedValueOnce(new Error('bcrypt failed'));
      const failed = request(username, ip);
      await handler(failed.req, failed.res);
      expect(failed.res.status).toHaveBeenCalledWith(500);
      expect(Number(await client.get(accountKey))).toBe(3);

      mocks.verifyCredentials.mockResolvedValue({ id: '1', username });
      const success = request(username, ip);
      await handler(success.req, success.res);
      expect(success.res.status).toHaveBeenCalledWith(200);
      expect(await client.exists(pairKey)).toBe(0);
      expect(Number(await client.get(accountKey))).toBe(3);
      expect(Number(await client.get(ipKey))).toBe(3);
      expect(await client.ttl(accountKey)).toBeLessThanOrEqual(300);
    });

    it('repairs a lockout counter that lost its expiry and keeps rejecting', async () => {
      const username = `${prefix}-legacy`;
      const ip = '192.0.2.99';
      track(username, [ip]);
      const accountKey = attemptKey('account', username);
      await client.set(accountKey, '10');

      const { req, res } = request(username, ip);
      await handler(req, res);

      expect(mocks.verifyCredentials).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ retryAfterSeconds: 900 }),
      );
      expect(await client.ttl(accountKey)).toBe(900);
    });
  },
);
