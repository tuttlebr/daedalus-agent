import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUN_REAL_REDIS = process.env.RUN_REDIS_STREAM_INTEGRATION === '1';

describe.skipIf(!RUN_REAL_REDIS)(
  'normalized live stream state with real Redis',
  () => {
    let client: any;
    let state: typeof import('@/server/chat/streamState');
    let jobId: string;
    let statusKey: string;

    beforeAll(async () => {
      if (!process.env.REDIS_URL) {
        throw new Error(
          'RUN_REDIS_STREAM_INTEGRATION requires REDIS_URL for a disposable Redis instance',
        );
      }

      jobId = `stream-state-${process.pid}-${Date.now()}`;
      statusKey = `async-job-status:${jobId}`;
      state = await import('@/server/chat/streamState');
      const redis = await import('@/server/session/redis');
      client = redis.getRedis();
      if (client.status === 'wait') await client.connect();
      await client.del(
        statusKey,
        state.streamResponseKey(jobId),
        state.streamStepsKey(jobId),
        state.legacyStreamStepsKey(jobId),
      );
    });

    afterAll(async () => {
      if (client) {
        await client
          .del(
            statusKey,
            state.streamResponseKey(jobId),
            state.streamStepsKey(jobId),
            state.legacyStreamStepsKey(jobId),
          )
          .catch(() => 0);
        client.disconnect();
      }
    });

    it('assembles 200 deltas and steps without growing the status document', async () => {
      const originalStatus = JSON.stringify({
        jobId,
        status: 'streaming',
        updatedAt: 1,
      });
      await client.set(statusKey, originalStatus, 'EX', 3600);

      const deltas = Array.from({ length: 200 }, (_, index) => `[${index}]`);
      const steps = Array.from({ length: 200 }, (_, index) => ({
        id: index,
        payload: { event_type: index % 2 ? 'TOOL_END' : 'TOOL_START' },
      }));

      for (let offset = 0; offset < deltas.length; offset += 10) {
        await state.appendStreamResponseDelta(
          jobId,
          deltas.slice(offset, offset + 10).join(''),
        );
        await state.appendStreamSteps(jobId, steps.slice(offset, offset + 10));
      }

      await expect(state.getStreamResponse(jobId)).resolves.toBe(
        deltas.join(''),
      );
      await expect(state.getStreamSteps(jobId)).resolves.toEqual(steps);
      await expect(client.get(statusKey)).resolves.toBe(originalStatus);
      expect(await client.llen(state.streamStepsKey(jobId))).toBe(200);
      expect(await client.ttl(state.streamResponseKey(jobId))).toBeGreaterThan(
        0,
      );
      expect(await client.ttl(state.streamStepsKey(jobId))).toBeGreaterThan(0);

      await state.clearStreamState(jobId);
      expect(
        await client.exists(
          state.streamResponseKey(jobId),
          state.streamStepsKey(jobId),
        ),
      ).toBe(0);
    });
  },
);
