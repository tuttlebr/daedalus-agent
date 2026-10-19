import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'OAuth progress with real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let state: typeof import('@/server/chat/jobState');
    let client: ReturnType<typeof redis.getRedis>;

    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('Disposable REDIS_URL required');
      redis = await import('@/server/session/redis');
      state = await import('@/server/chat/jobState');
      client = redis.getRedis();
      if (client.status === 'wait') await client.connect();
    });

    afterAll(() => client?.disconnect());

    it.each([
      ['plain', 'progress'],
      ['json', 'progress'],
      ['plain', 'new prompt'],
      ['json', 'new prompt'],
    ])('preserves a callback racing %s %s', async (format, action) => {
      const jobId = `oauth-race-${
        process.pid
      }-${Date.now()}-${format}-${action}`;
      const key = redis.sessionKey(['async-job-status', jobId]);
      const prompt = {
        id: 'first',
        authUrl: 'https://accounts.google.com/first',
        oauthState: 'first',
      };
      const next = {
        id: 'second',
        authUrl: 'https://accounts.google.com/second',
        oauthState: 'second',
      };
      const initial = {
        jobId,
        status: 'oauth_required',
        createdAt: 1,
        updatedAt: 1,
        ...{ authUrl: prompt.authUrl, oauthState: prompt.oauthState },
        oauthRequests: [prompt],
        intermediateSteps: [],
      };
      if (format === 'plain')
        await client.set(key, JSON.stringify(initial), 'EX', 120);
      else await client.call('JSON.SET', key, '$', JSON.stringify(initial));
      let injected = false;
      const evaluate = client.eval.bind(client);
      const spy = vi
        .spyOn(client, 'eval')
        .mockImplementation(async (...args: any[]) => {
          const result = await evaluate(
            ...(args as Parameters<typeof client.eval>),
          );
          if (
            !injected &&
            args[2] === key &&
            String(args[0]).includes('READ_JOB_STATUS_SNAPSHOT')
          ) {
            injected = true;
            await expect(
              state.completeOAuthJobRequest(jobId, 'first'),
            ).resolves.toBe(true);
          }
          return result;
        });
      try {
        if (action === 'progress')
          await state.markJobStreaming(jobId, Date.now());
        else
          await expect(state.recordOAuthJobRequest(jobId, next)).resolves.toBe(
            true,
          );
        expect(injected).toBe(true);
        const saved = await redis.jsonGet(key);
        expect(saved.status).toBe(
          action === 'progress' ? 'streaming' : 'oauth_required',
        );
        expect(saved.oauthRequests).toEqual(
          action === 'progress' ? undefined : [next],
        );
        expect(saved.intermediateSteps).toEqual([]);
        expect(saved.oauthState).toBe(
          action === 'progress' ? undefined : 'second',
        );
      } finally {
        spy.mockRestore();
        await client.del(key);
      }
    });
  },
);
