import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'OAuth progress with real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let state: typeof import('@/server/chat/jobState');
    let client: ReturnType<typeof redis.getRedis>;

    // Durable journal contents, as written.
    const journalOf = async (job: string) => {
      const raw = await client.get(state.finalizationJournalKey(job));
      return raw ? JSON.parse(raw) : null;
    };
    const claimTerminal = async (
      ...args: Parameters<typeof state.claimTerminalJobStatus>
    ) => (await state.claimTerminalJobStatus(...args)).claimed;

    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('Disposable REDIS_URL required');
      redis = await import('@/server/session/redis');
      state = await import('@/server/chat/jobState');
      client = redis.getRedis();
      if (client.status === 'wait') await client.connect();
    });

    afterAll(() => client?.disconnect());

    it.each(['plain', 'json'])(
      'persists and publishes backend acceptance for a %s status without output',
      async (format) => {
        const jobId = `accepted-${process.pid}-${Date.now()}-${format}`;
        const key = redis.sessionKey(['async-job-status', jobId]);
        const subscriber = client.duplicate();
        const channel = `job:${jobId}:status`;
        const initial = {
          jobId,
          status: 'pending',
          createdAt: 1,
          updatedAt: 1,
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (format === 'plain')
            await client.set(key, JSON.stringify(initial), 'EX', 120);
          else await client.call('JSON.SET', key, '$', JSON.stringify(initial));
          await subscriber.subscribe(channel);
          const notice = new Promise<any>((resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Backend acceptance was not published')),
              1000,
            );
            subscriber.on('message', (topic, raw) => {
              if (topic === channel) resolve(JSON.parse(raw));
            });
          });
          await state.markJobStreaming(jobId, 42);
          const expected = { ...initial, status: 'streaming', updatedAt: 42 };
          expect(await notice).toEqual(expected);
          expect(await redis.jsonGet(key)).toEqual(expected);
        } finally {
          clearTimeout(timer);
          subscriber.disconnect();
          await client.del(key);
        }
      },
    );

    it.each(['plain', 'json'])(
      'deletes only a live %s status',
      async (format) => {
        const live = `delete-live-${process.pid}-${Date.now()}-${format}`;
        const done = `${live}-done`;
        const write = async (jobId: string, status: Record<string, any>) => {
          const key = redis.sessionKey(['async-job-status', jobId]);
          const value = JSON.stringify({ jobId, createdAt: 1, ...status });
          if (format === 'plain') await client.set(key, value, 'EX', 120);
          else await client.call('JSON.SET', key, '$', value);
          return key;
        };
        const liveKey = await write(live, { status: 'pending' });
        const doneKey = await write(done, {
          status: 'error',
          finalizedAt: 2,
        });
        try {
          expect(await state.deleteLiveJobStatus(live)).toBe(true);
          expect(await client.exists(liveKey)).toBe(0);
          expect(await state.deleteLiveJobStatus(done)).toBe(false);
          expect(await client.exists(doneKey)).toBe(1);
          expect(await state.deleteLiveJobStatus(`${live}-missing`)).toBe(
            false,
          );
        } finally {
          await client.del(liveKey, doneKey);
        }
      },
    );

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

    it.each(['plain', 'json'])(
      'rebuilds a %s terminal claim when a live update lands after its snapshot read',
      async (format) => {
        const jobId = `terminal-race-${process.pid}-${Date.now()}-${format}`;
        const key = redis.sessionKey(['async-job-status', jobId]);
        const journalKey = state.finalizationJournalKey(jobId);
        const initial = JSON.stringify({
          jobId,
          status: 'streaming',
          partialResponse: 'older',
          createdAt: 1,
          updatedAt: 1,
        });
        if (format === 'plain') await client.set(key, initial, 'EX', 120);
        else await client.call('JSON.SET', key, '$', initial);
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
              await state.updateJobStatus(jobId, {
                partialResponse: 'newer',
                updatedAt: 2,
              });
            }
            return result;
          });
        try {
          await expect(
            claimTerminal(
              jobId,
              {
                status: 'error',
                error: 'stopped',
                updatedAt: 3,
                finalizedAt: 3,
              },
              {
                version: 1,
                state: 'pending',
                jobId,
                finalizationId: `${jobId}-error`,
                outcome: 'error',
                userId: 'terminal-race-user',
                finalizedAt: 3,
              },
            ),
          ).resolves.toBe(true);
          expect(injected).toBe(true);
          // The claim must compare its snapshot: a terminal write built from
          // the older read would silently discard the concurrent update.
          expect(await redis.jsonGet(key)).toMatchObject({
            status: 'error',
            partialResponse: 'newer',
            finalizedAt: 3,
          });
          expect((await journalOf(jobId))?.terminalStatus).toMatchObject({
            partialResponse: 'newer',
          });
        } finally {
          spy.mockRestore();
          await client.del(key, journalKey);
        }
      },
    );
  },
);
