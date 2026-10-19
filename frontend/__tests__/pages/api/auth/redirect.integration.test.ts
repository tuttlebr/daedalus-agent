// @vitest-environment node
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'Google OAuth callback binding with real sessions and Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let oauth: typeof import('@/server/mcpOAuth');
    let handler: typeof import('@/pages/api/auth/redirect')['default'];
    let backend: http.Server;
    let backendBaseUrl: string;
    const forwarded: string[] = [];
    const keys: string[] = [];
    const alice = `oauth-alice-${process.pid}`;
    const bob = `oauth-bob-${process.pid}`;
    const state = `oauth-binding-${process.pid}-${Date.now()}`;

    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('Disposable REDIS_URL required');
      backend = http.createServer((req, res) => {
        forwarded.push(req.url || '');
        res.setHeader('Content-Type', 'application/json');
        res.end('{"status":"authorization_received"}');
      });
      backend.listen(0, '127.0.0.1');
      await once(backend, 'listening');
      const { port } = backend.address() as AddressInfo;
      backendBaseUrl = `http://127.0.0.1:${port}`;
      vi.resetModules();
      // The Compose backend service address is an allowed callback target.
      vi.stubEnv('BACKEND_HOST', '127.0.0.1');
      vi.stubEnv('BACKEND_PORT', String(port));
      vi.stubEnv('DEPLOYMENT_MODE', 'local');
      vi.stubEnv('KUBERNETES_SERVICE_HOST', '');
      const hash =
        '$2a$12$7yi3/acb3vGBzFr8czKX5OZVF7mCiyyR567M9NEFEKN07KqJeKWQK';
      vi.stubEnv('AUTH_USER_1_USERNAME', alice);
      vi.stubEnv('AUTH_USER_1_PASSWORD_HASH', hash);
      vi.stubEnv('AUTH_USER_2_USERNAME', bob);
      vi.stubEnv('AUTH_USER_2_PASSWORD_HASH', hash);
      vi.stubEnv('AUTH_USER_3_USERNAME', '');
      redis = await import('@/server/session/redis');
      oauth = await import('@/server/mcpOAuth');
      handler = (await import('@/pages/api/auth/redirect')).default;
    });
    afterAll(async () => {
      vi.unstubAllEnvs();
      backend?.close();
      if (redis) {
        if (keys.length) await redis.getRedis().del(...keys);
        await oauth?.deleteOAuthCallbackTarget(state);
        redis.getRedis().disconnect();
      }
    });

    async function signIn(username: string): Promise<string> {
      const sid = `${username}-${keys.length}`;
      const key = redis.sessionKey(['auth-session', sid]);
      keys.push(key);
      await redis.jsonSetWithExpiry(
        key,
        {
          userId: username,
          username,
          name: username,
          loginTime: Date.now(),
          lastActivity: Date.now(),
        },
        120,
      );
      return sid;
    }

    async function request(
      method: 'GET' | 'POST',
      params: Record<string, string>,
      sid?: string,
    ) {
      const req = {
        method,
        query: method === 'GET' ? params : {},
        body: method === 'POST' ? params : undefined,
        headers: {
          host: 'daedalus.example.test',
          ...(sid ? { cookie: `sid=${sid}` } : {}),
        },
      } as any;
      const res = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
        setHeader: vi.fn(),
      } as any;
      await handler(req, res);
      return {
        status: res.status.mock.calls[0][0],
        body: res.send.mock.calls[0][0],
      };
    }

    it("completes a consent only from the initiating user's own session", async () => {
      await oauth.saveOAuthCallbackTarget(
        state,
        backendBaseUrl,
        'job-bob',
        bob,
      );
      const params = { state, code: 'alice-google-code' };

      // Google's cross-site redirect carries no strict session cookie.
      const page = await request('GET', params);
      expect(page.status).toBe(200);
      expect(page.body).toContain(`name="state" value="${state}"`);
      expect(await request('POST', params)).toMatchObject({ status: 401 });
      // Bob forwarded his consent link to Alice.
      expect(await request('POST', params, await signIn(alice))).toMatchObject({
        status: 403,
      });
      expect(forwarded).toEqual([]);
      expect(await oauth.loadOAuthCallbackTarget(state)).not.toBeNull();

      const completed = await request(
        'POST',
        { state, code: 'bob-google-code' },
        await signIn(bob),
      );
      expect(completed).toMatchObject({
        status: 200,
        body: '{"status":"authorization_received"}',
      });
      expect(forwarded).toEqual([
        `/auth/redirect?state=${state}&code=bob-google-code`,
      ]);
      expect(await oauth.loadOAuthCallbackTarget(state)).toBeNull();
    });
  },
);
