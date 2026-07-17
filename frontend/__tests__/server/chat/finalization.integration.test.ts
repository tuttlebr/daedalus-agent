import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUN_REAL_REDIS = process.env.RUN_REDIS_STREAM_INTEGRATION === '1';

describe.skipIf(!RUN_REAL_REDIS)(
  'terminal finalization recovery with real Redis',
  () => {
    let client: any;
    let subscriber: any;
    let redis: typeof import('@/server/session/redis');
    let state: typeof import('@/server/chat/jobState');
    let streamState: typeof import('@/server/chat/streamState');
    let conversationGuard: typeof import('@/server/chat/conversationJobGuard');
    let finalization: typeof import('@/server/chat/finalization');
    let jobId: string;
    let conversationId: string;
    let userId: string;
    const observedMessages: Array<{ channel: string; payload: any }> = [];

    beforeAll(async () => {
      if (!process.env.REDIS_URL) {
        throw new Error(
          'RUN_REDIS_STREAM_INTEGRATION requires REDIS_URL for a disposable Redis instance',
        );
      }

      jobId = `finalization-${process.pid}-${Date.now()}`;
      conversationId = `conversation-${jobId}`;
      userId = `user-${jobId}`;
      redis = await import('@/server/session/redis');
      state = await import('@/server/chat/jobState');
      streamState = await import('@/server/chat/streamState');
      conversationGuard = await import('@/server/chat/conversationJobGuard');
      finalization = await import('@/server/chat/finalization');
      client = redis.getRedis();
      if (client.status === 'wait') await client.connect();
      subscriber = client.duplicate();
      if (subscriber.status === 'wait') await subscriber.connect();
      subscriber.on('message', (channel: string, payload: string) => {
        observedMessages.push({ channel, payload: JSON.parse(payload) });
      });
      await subscriber.subscribe(
        `job:${jobId}:status`,
        redis.channels.userUpdates(userId),
        `user:${userId}:chat:${conversationId}:tokens`,
      );
    });

    afterAll(async () => {
      if (subscriber) subscriber.disconnect();
      if (client) {
        await client
          .del(
            redis.sessionKey(['async-job-status', jobId]),
            state.finalizationJournalKey(jobId),
            state.finalizerLockKey(jobId),
            state.abortKey(jobId),
            redis.sessionKey(['conversation', conversationId]),
            redis.sessionKey(['user', userId, 'selectedConversation']),
            redis.sessionKey([
              'streaming',
              'user',
              userId,
              'conversation',
              conversationId,
            ]),
            streamState.streamResponseKey(jobId),
            streamState.streamStepsKey(jobId),
            streamState.legacyStreamStepsKey(jobId),
            conversationGuard.conversationJobGuardKey(userId, conversationId),
          )
          .catch(() => 0);
        client.disconnect();
      }
    });

    it('recovers a crash after the first terminal outcome without duplicating effects', async () => {
      const finalizedAt = Date.now();
      const statusKey = redis.sessionKey(['async-job-status', jobId]);
      const conversationKey = redis.sessionKey([
        'conversation',
        conversationId,
      ]);
      await redis.jsonSetWithExpiry(
        statusKey,
        {
          jobId,
          status: 'streaming',
          partialResponse: 'in flight',
          createdAt: finalizedAt - 100,
          updatedAt: finalizedAt - 10,
          conversationId,
        },
        3600,
      );
      await redis.jsonSetWithExpiry(
        redis.sessionKey(['user', userId, 'selectedConversation']),
        { id: conversationId, name: 'Old name', messages: [] },
        3600,
      );
      await redis.setStreamingState(userId, conversationId, jobId);
      await expect(
        conversationGuard.acquireConversationJobGuard(
          userId,
          conversationId,
          jobId,
          client,
        ),
      ).resolves.toEqual(expect.objectContaining({ acquired: true }));
      await streamState.appendStreamResponseDelta(jobId, 'uncommitted');
      await streamState.appendStreamSteps(jobId, [
        { id: 'step-1', payload: { event_type: 'TOOL_END' } },
      ]);

      const successId = `${jobId}-success`;
      const errorId = `${jobId}-cancel`;
      const commonConversation = {
        id: conversationId,
        name: 'Recovered conversation',
        messages: [{ id: 'user-1', role: 'user', content: 'hello' }],
        assistantMessageId: 'assistant-1',
        turnId: 'turn-1',
        intermediateSteps: [
          { id: 'step-1', payload: { event_type: 'TOOL_END' } },
        ],
      };

      const [successClaimed, cancelClaimed] = await Promise.all([
        state.claimTerminalJobStatus(
          jobId,
          {
            status: 'completed',
            fullResponse: 'Recovered answer',
            partialResponse: undefined,
            error: undefined,
            intermediateSteps: commonConversation.intermediateSteps,
            assistantMessageId: 'assistant-1',
            turnId: 'turn-1',
            progress: 100,
            updatedAt: finalizedAt,
            finalizedAt,
          },
          {
            version: 1,
            state: 'pending',
            jobId,
            finalizationId: successId,
            outcome: 'completed',
            userId,
            finalizedAt,
            conversation: {
              ...commonConversation,
              content: 'Recovered answer',
              isPartial: false,
            },
          },
        ),
        state.claimTerminalJobStatus(
          jobId,
          {
            status: 'error',
            error: 'Job canceled by user',
            partialResponse: 'Recovered partial answer',
            fullResponse: undefined,
            intermediateSteps: commonConversation.intermediateSteps,
            assistantMessageId: 'assistant-1',
            turnId: 'turn-1',
            updatedAt: finalizedAt + 1,
            finalizedAt: finalizedAt + 1,
          },
          {
            version: 1,
            state: 'pending',
            jobId,
            finalizationId: errorId,
            outcome: 'error',
            userId,
            finalizedAt: finalizedAt + 1,
            conversation: {
              ...commonConversation,
              content: 'Recovered partial answer',
              isPartial: true,
              error: 'Job canceled by user',
            },
          },
        ),
      ]);

      expect([successClaimed, cancelClaimed].filter(Boolean)).toHaveLength(1);
      const pending = await state.getFinalizationJournal(jobId);
      expect(pending).toEqual(
        expect.objectContaining({
          state: 'pending',
          finalizationId: successClaimed ? successId : errorId,
          outcome: successClaimed ? 'completed' : 'error',
        }),
      );
      expect(await client.exists(conversationKey)).toBe(0);

      const recoveryResults = await Promise.all([
        finalization.resumePendingFinalization(jobId),
        finalization.resumePendingFinalization(jobId),
      ]);
      expect(recoveryResults).toContain('completed');

      const completed = await state.getFinalizationJournal(jobId);
      expect(completed).toEqual(
        expect.objectContaining({
          state: 'completed',
          conversationAppliedAt: expect.any(Number),
          streamingStateClearedAt: expect.any(Number),
          eventsPublishedAt: expect.any(Number),
          streamStateClearedAt: expect.any(Number),
          conversationGuardReleasedAt: expect.any(Number),
          completedAt: expect.any(Number),
        }),
      );
      const conversation = await redis.jsonGet(conversationKey);
      expect(conversation.messages).toHaveLength(2);
      expect(conversation.messages[1]).toEqual(
        expect.objectContaining({
          id: 'assistant-1',
          content: successClaimed
            ? 'Recovered answer'
            : 'Recovered partial answer',
          metadata: expect.objectContaining({
            jobId,
            finalizationId: successClaimed ? successId : errorId,
          }),
        }),
      );
      expect(
        await client.exists(
          redis.sessionKey([
            'streaming',
            'user',
            userId,
            'conversation',
            conversationId,
          ]),
          streamState.streamResponseKey(jobId),
          streamState.streamStepsKey(jobId),
        ),
      ).toBe(0);
      expect(
        await client.exists(
          conversationGuard.conversationJobGuardKey(userId, conversationId),
        ),
      ).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 25));
      const completionEventsBeforeRetry = observedMessages.filter(
        ({ payload }) => payload.type === 'chat_complete',
      );
      expect(completionEventsBeforeRetry).toHaveLength(1);
      const eventsPublishedAt = completed?.eventsPublishedAt;

      await expect(finalization.resumePendingFinalization(jobId)).resolves.toBe(
        'completed',
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(
        observedMessages.filter(
          ({ payload }) => payload.type === 'chat_complete',
        ),
      ).toHaveLength(1);
      expect(
        (await state.getFinalizationJournal(jobId))?.eventsPublishedAt,
      ).toBe(eventsPublishedAt);
    });
  },
);
