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

    it.each(['live', 'handed off', 'authorized after handoff'])(
      'preserves accepted output when cancelling a %s OAuth request',
      async (phase) => {
        const jobId = `${prefix}-${phase}`;
        const statusKey = redis.sessionKey(['async-job-status', jobId]);
        const requestKey = redis.sessionKey(['async-job-request', jobId]);
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
              await state.recordOAuthJobRequest(jobId, {
                id: 'waiting',
                authUrl: 'https://accounts.google.com/auth',
                oauthState: 'waiting',
              });
              reportPrompt();
              await mayFinish;
              // The actual reader's buffering/abort path is covered by async.test.
              // Here the boundary exposes output only when the owner is done.
              await streams.appendStreamResponseDelta(
                jobId,
                'Accepted sibling output.',
                0,
              );
            },
          );
        let processing: Promise<unknown> | undefined;
        try {
          await redis.jsonSetWithExpiry(
            requestKey,
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
            statusKey,
            {
              jobId,
              status: 'pending',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            120,
          );
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
          if (phase !== 'live') {
            releaseReader();
            await expect(processing).resolves.toBe('oauth_required');
            if (phase === 'authorized after handoff')
              await expect(
                state.completeOAuthJobRequest(jobId, 'waiting'),
              ).resolves.toBe(true);
          }
          const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis(),
          };
          await handler(
            { method: 'DELETE', query: { jobId } } as any,
            res as any,
          );
          expect(res.status).toHaveBeenCalledWith(200);
          expect(res.json).toHaveBeenCalledWith({
            success: true,
            canceled: true,
          });
          if (phase === 'live') {
            expect(
              (await redis.jsonGet(statusKey)).finalizedAt,
            ).toBeUndefined();
            expect(await queue.loadStreamQueuePayload(jobId)).not.toBeNull();
            releaseReader();
            await expect(processing).resolves.toBe('completed');
          }
          expect(await redis.jsonGet(statusKey)).toMatchObject({
            status: 'error',
            error: 'Job canceled by user',
            partialResponse: 'Accepted sibling output.',
          });
          expect(await queue.loadStreamQueuePayload(jobId)).toBeNull();
          expect(await client.xlen(queue.STREAM_QUEUE_KEY)).toBe(0);
        } finally {
          releaseReader();
          await processing?.catch(() => {});
          spy.mockRestore();
          await client.del(
            statusKey,
            requestKey,
            state.abortKey(jobId),
            state.finalizationJournalKey(jobId),
            queue.streamPayloadKey(jobId),
            queue.streamBackendStartedKey(jobId),
            queue.streamLeaseKey(jobId),
            streams.streamResponseKey(jobId),
          );
        }
      },
    );
  },
);
