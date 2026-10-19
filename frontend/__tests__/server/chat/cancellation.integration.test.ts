import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/auth/session', () => ({
  getSession: vi.fn(async () => ({ username: 'oauth-cancel-user' })),
}));
vi.mock('@/server/chat/steering', () => ({
  forwardCancellation: vi.fn(async () => {}),
}));

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'OAuth cancellation ownership with real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let queue: typeof import('@/server/chat/streamQueue');
    let state: typeof import('@/server/chat/jobState');
    let streams: typeof import('@/server/chat/streamState');
    let worker: typeof import('@/server/chat/streamWorker');
    let reader: typeof import('@/server/chat/streamReader');
    let handler: typeof import('@/pages/api/chat/async').default;
    let client: ReturnType<typeof redis.getRedis>;
    const prefix = `oauth-cancel-${process.pid}-${Date.now()}`;

    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('Disposable REDIS_URL required');
      vi.stubEnv('STREAM_WORKER_QUEUE_KEY', `${prefix}:queue`);
      vi.stubEnv('STREAM_WORKER_GROUP', `${prefix}:group`);
      redis = await import('@/server/session/redis');
      queue = await import('@/server/chat/streamQueue');
      state = await import('@/server/chat/jobState');
      streams = await import('@/server/chat/streamState');
      worker = await import('@/server/chat/streamWorker');
      reader = await import('@/server/chat/streamReader');
      handler = (await import('@/pages/api/chat/async')).default;
      client = redis.getRedis();
      if (client.status === 'wait') await client.connect();
      await queue.ensureStreamConsumerGroup(client);
    });

    afterAll(async () => {
      if (client) {
        await client.del(queue.STREAM_QUEUE_KEY);
        client.disconnect();
      }
      vi.unstubAllEnvs();
    });

    const jobKeys = (jobId: string) => [
      redis.sessionKey(['async-job-status', jobId]),
      redis.sessionKey(['async-job-request', jobId]),
      state.abortKey(jobId),
      state.finalizationJournalKey(jobId),
      queue.streamPayloadKey(jobId),
      queue.streamBackendStartedKey(jobId),
      queue.streamLeaseKey(jobId),
      streams.streamResponseKey(jobId),
    ];

    async function seedJob(jobId: string): Promise<void> {
      await redis.jsonSetWithExpiry(
        redis.sessionKey(['async-job-request', jobId]),
        {
          jobId,
          userId: 'oauth-cancel-user',
          executionMode: 'stream',
          messages: [],
          natBaseUrl: 'http://127.0.0.1:1',
        },
        120,
      );
      await redis.jsonSetWithExpiry(
        redis.sessionKey(['async-job-status', jobId]),
        {
          jobId,
          status: 'pending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        120,
      );
    }

    async function cancel(jobId: string) {
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      };
      await handler({ method: 'DELETE', query: { jobId } } as any, res as any);
      expect(res.status).toHaveBeenCalledWith(200);
      return res.json.mock.calls[0][0];
    }

    async function prompt(jobId: string): Promise<void> {
      await state.recordOAuthJobRequest(jobId, {
        id: 'waiting',
        authUrl: 'https://accounts.google.com/auth',
        oauthState: 'waiting',
      });
    }

    it.each(['live', 'reader returned'])(
      'preserves accepted output for a %s OAuth request',
      async (phase) => {
        const jobId = `${prefix}-${phase.replace(' ', '-')}`;
        const statusKey = redis.sessionKey(['async-job-status', jobId]);
        let releaseReader!: () => void;
        const mayFinish = new Promise<void>((resolve) => {
          releaseReader = resolve;
        });
        let reportPrompt!: () => void;
        const prompted = new Promise<void>((resolve) => {
          reportPrompt = resolve;
        });
        const spy = vi
          .spyOn(reader, 'startBackgroundStreamReader')
          .mockImplementation(
            async (_id, _request, _messages, _user, control) => {
              await control!.beforeBackendRequest!();
              await prompt(jobId);
              reportPrompt();
              const signal = control!.signal!;
              // The actual reader's buffering/abort path is covered by async.test.
              // Here the boundary exposes output only when the owner is done:
              // at the worker's stop signal, or when the backend stream ends.
              await (phase === 'live'
                ? new Promise<void>((resolve) =>
                    signal.addEventListener('abort', () => resolve(), {
                      once: true,
                    }),
                  )
                : mayFinish);
              await streams.appendStreamResponseDelta(
                jobId,
                'Accepted sibling output.',
                0,
              );
              if (signal.aborted) throw signal.reason;
            },
          );
        let processing: Promise<unknown> | undefined;
        try {
          await seedJob(jobId);
          await queue.enqueueStreamJob(jobId, {
            messagesForNat: [],
            verifiedUsername: 'oauth-cancel-user',
          });
          const [entry] = await queue.readNewStreamJobs(
            client,
            'owner',
            1,
            100,
          );
          processing = worker.processStreamQueueEntry(
            entry,
            worker.streamWorkerOptionsFromEnv(),
            undefined,
            'owner',
          );
          await prompted;
          if (phase === 'live') {
            expect(await cancel(jobId)).toEqual({
              success: true,
              canceled: true,
            });
            expect(
              (await redis.jsonGet(statusKey)).finalizedAt,
            ).toBeUndefined();
            expect(await queue.loadStreamQueuePayload(jobId)).not.toBeNull();
            await expect(processing).resolves.toBe('recovered_as_error');
            expect(await redis.jsonGet(statusKey)).toMatchObject({
              status: 'error',
              error: 'Job canceled by user',
              partialResponse: 'Accepted sibling output.',
            });
          } else {
            // The backend run that issued the prompt ended with its stream.
            // The worker owns the outcome; it never parks the job for later.
            releaseReader();
            await expect(processing).resolves.toBe('recovered_as_error');
            expect(await redis.jsonGet(statusKey)).toMatchObject({
              status: 'error',
              error:
                'The backend stream ended without producing a terminal result.',
              partialResponse: 'Accepted sibling output.',
            });
            expect(await cancel(jobId)).toEqual({
              success: true,
              canceled: false,
            });
          }
          expect(await queue.loadStreamQueuePayload(jobId)).toBeNull();
          expect(await client.xlen(queue.STREAM_QUEUE_KEY)).toBe(0);
        } finally {
          releaseReader();
          await processing?.catch(() => {});
          spy.mockRestore();
          await client.del(...jobKeys(jobId));
        }
      },
    );

    // An earlier frontend acknowledged a job awaiting OAuth and left it live
    // without a payload. Stop remains the way to finish such records.
    it.each(['pending', 'authorized'])(
      'cancels a %s OAuth job parked by an earlier version',
      async (phase) => {
        const jobId = `${prefix}-parked-${phase}`;
        const statusKey = redis.sessionKey(['async-job-status', jobId]);
        try {
          await seedJob(jobId);
          await prompt(jobId);
          await streams.appendStreamResponseDelta(
            jobId,
            'Accepted sibling output.',
            0,
          );
          if (phase === 'authorized')
            await expect(
              state.completeOAuthJobRequest(jobId, 'waiting'),
            ).resolves.toBe(true);
          expect(await cancel(jobId)).toEqual({
            success: true,
            canceled: true,
          });
          expect(await redis.jsonGet(statusKey)).toMatchObject({
            status: 'error',
            error: 'Job canceled by user',
            partialResponse: 'Accepted sibling output.',
          });
        } finally {
          await client.del(...jobKeys(jobId));
        }
      },
    );
  },
);
