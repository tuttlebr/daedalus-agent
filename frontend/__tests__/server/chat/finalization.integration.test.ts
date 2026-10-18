import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
    let memoryServer: Server;
    const memoryRequests: any[] = [];
    let memoryUnavailable = false;
    let memoryResponseClosed: (() => void) | undefined;
    const previousBackend = {
      host: process.env.BACKEND_HOST,
      port: process.env.BACKEND_PORT,
    };
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
      memoryServer = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        memoryRequests.push(JSON.parse(body));
        if (memoryUnavailable) {
          // A failing gateway that never finishes its diagnostic body.
          res.on('close', () => memoryResponseClosed?.());
          res.writeHead(503, { 'Content-Type': 'text/html' });
          res.write('<html>unavailable');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ operation_id: `memory-${jobId}` }));
      });
      await new Promise<void>((resolve) =>
        memoryServer.listen(0, '127.0.0.1', resolve),
      );
      process.env.BACKEND_HOST = '127.0.0.1';
      process.env.BACKEND_PORT = String(
        (memoryServer.address() as { port: number }).port,
      );
      redis = await import('@/server/session/redis');
      state = await import('@/server/chat/jobState');
      streamState = await import('@/server/chat/streamState');
      conversationGuard = await import('@/server/chat/conversationJobGuard');
      finalization = await import('@/server/chat/finalization');
      client = redis.getRedis();
      if (client.status === 'wait') await client.connect();
      const { reserveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      // The submission API reserves ownership before it queues this job.
      await reserveConversationForUser(userId, conversationId);
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
      if (memoryServer)
        await new Promise<void>((resolve) =>
          memoryServer.close(() => resolve()),
        );
      if (previousBackend.host === undefined) delete process.env.BACKEND_HOST;
      else process.env.BACKEND_HOST = previousBackend.host;
      if (previousBackend.port === undefined) delete process.env.BACKEND_PORT;
      else process.env.BACKEND_PORT = previousBackend.port;
      if (subscriber) subscriber.disconnect();
      if (client) {
        await client
          .del(
            redis.sessionKey(['async-job-status', jobId]),
            state.finalizationJournalKey(jobId),
            state.finalizerLockKey(jobId),
            state.abortKey(jobId),
            redis.sessionKey(['conversation', conversationId]),
            redis.sessionKey(['user', userId, 'conversations']),
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
            redis.sessionKey(['memory-retention', 'record', 'v1', jobId]),
            redis.sessionKey(['memory-retention', 'user', userId, 'v1']),
          )
          .catch(() => 0);
        await client.zrem(
          redis.sessionKey(['memory-retention', 'queue', 'v1']),
          jobId,
        );
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
      await streamState.appendStreamResponseDelta(jobId, 'uncommitted', 0);
      await streamState.appendStreamSteps(
        jobId,
        [{ id: 'step-1', payload: { event_type: 'TOOL_END' } }],
        0,
      );

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
      // Submission reserved an empty owned record; no terminal answer is saved yet.
      expect(await redis.jsonGet(conversationKey)).toMatchObject({
        ownerId: userId,
        messages: [],
      });

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
      expect(memoryRequests).toHaveLength(successClaimed ? 1 : 0);
      if (successClaimed) expect(memoryRequests[0].request_id).toBe(jobId);
    });

    it('keeps a rename saved while the response was running', async () => {
      const { saveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      const renameJob = `${jobId}-rename`;
      const renamedConversation = `${conversationId}-rename`;
      const statusKey = redis.sessionKey(['async-job-status', renameJob]);
      const conversationKey = redis.sessionKey([
        'conversation',
        renamedConversation,
      ]);
      const selectedKey = redis.sessionKey([
        'user',
        userId,
        'selectedConversation',
      ]);
      const submittedAt = Date.now() - 1_000;
      const userMessage = { id: 'rename-user', role: 'user', content: 'Plan' };
      // Submission saves the client's auto-generated name and reserves it.
      await saveConversationForUser(
        userId,
        renamedConversation,
        () => ({
          id: renamedConversation,
          name: 'Plan',
          messages: [userMessage],
          updatedAt: submittedAt - 1,
        }),
        true,
      );
      await redis.jsonSetWithExpiry(
        statusKey,
        {
          jobId: renameJob,
          status: 'streaming',
          createdAt: submittedAt,
          updatedAt: submittedAt,
          conversationId: renamedConversation,
        },
        120,
      );
      await redis.jsonSetWithExpiry(
        selectedKey,
        { id: renamedConversation, name: 'Plan', messages: [userMessage] },
        120,
      );
      // The sidebar rename route writes a server timestamp after submission.
      await saveConversationForUser(userId, renamedConversation, (current) => ({
        ...current,
        name: 'Trip plan for March',
        updatedAt: Date.now(),
      }));
      await redis.jsonSetWithExpiry(
        selectedKey,
        {
          id: renamedConversation,
          name: 'Trip plan for March',
          messages: [userMessage],
        },
        120,
      );

      try {
        await expect(
          finalization.finalizeSuccess(
            renameJob,
            {
              jobId: renameJob,
              natBaseUrl: 'http://127.0.0.1:1',
              executionMode: 'stream',
              messages: [userMessage],
              userId,
              conversationId: renamedConversation,
              conversationName: 'Plan',
              assistantMessageId: 'rename-assistant',
            },
            'Here is the plan.',
          ),
        ).resolves.toBe(true);

        const saved = await redis.jsonGet(conversationKey);
        expect(saved.name).toBe('Trip plan for March');
        expect(saved.messages.map((message: any) => message.id)).toEqual([
          'rename-user',
          'rename-assistant',
        ]);
        expect((await redis.jsonGet(selectedKey)).name).toBe(
          'Trip plan for March',
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
        const updates = observedMessages.filter(
          ({ payload }) =>
            payload.type === 'conversation_updated' &&
            payload.data?.conversationId === renamedConversation,
        );
        expect(updates.at(-1)?.payload.data.conversation.name).toBe(
          'Trip plan for March',
        );
      } finally {
        await client.del(
          statusKey,
          conversationKey,
          state.finalizationJournalKey(renameJob),
          state.finalizerLockKey(renameJob),
          state.abortKey(renameJob),
          redis.sessionKey(['memory-retention', 'record', 'v1', renameJob]),
        );
        await client.zrem(
          redis.sessionKey(['memory-retention', 'queue', 'v1']),
          renameJob,
        );
      }
    });

    it('completes when memory retention fails and releases its unread response', async () => {
      const retainJob = `${jobId}-retain-failure`;
      const retainConversation = `${conversationId}-retain-failure`;
      const statusKey = redis.sessionKey(['async-job-status', retainJob]);
      const conversationKey = redis.sessionKey([
        'conversation',
        retainConversation,
      ]);
      const { reserveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      await reserveConversationForUser(userId, retainConversation);
      await redis.jsonSetWithExpiry(
        statusKey,
        { jobId: retainJob, status: 'streaming', createdAt: Date.now() },
        120,
      );
      const closed = new Promise<string>((resolve) => {
        memoryResponseClosed = () => resolve('closed');
      });
      memoryUnavailable = true;
      try {
        await expect(
          finalization.finalizeSuccess(
            retainJob,
            {
              jobId: retainJob,
              natBaseUrl: 'http://127.0.0.1:1',
              executionMode: 'stream',
              messages: [{ id: 'retain-user', role: 'user', content: 'Hi' }],
              userId,
              conversationId: retainConversation,
            },
            'Hello.',
          ),
        ).resolves.toBe(true);
        expect(await state.getFinalizationJournal(retainJob)).toMatchObject({
          state: 'completed',
          memoryRetentionAttemptedAt: expect.any(Number),
        });
        await expect(
          Promise.race([
            closed,
            new Promise((resolve) => setTimeout(() => resolve('open'), 1_000)),
          ]),
        ).resolves.toBe('closed');
      } finally {
        memoryUnavailable = false;
        memoryResponseClosed = undefined;
        await client.del(
          statusKey,
          conversationKey,
          state.finalizationJournalKey(retainJob),
          state.finalizerLockKey(retainJob),
          state.abortKey(retainJob),
        );
      }
    });

    it('applies the submitted name when no newer rename was saved', async () => {
      const { saveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      const nameJob = `${jobId}-name`;
      const namedConversation = `${conversationId}-name`;
      const statusKey = redis.sessionKey(['async-job-status', nameJob]);
      const conversationKey = redis.sessionKey([
        'conversation',
        namedConversation,
      ]);
      await saveConversationForUser(
        userId,
        namedConversation,
        () => ({
          id: namedConversation,
          name: 'New conversation',
          updatedAt: 0,
        }),
        true,
      );
      await redis.jsonSetWithExpiry(
        statusKey,
        { jobId: nameJob, status: 'streaming', createdAt: Date.now() },
        120,
      );
      try {
        await finalization.finalizeError(
          nameJob,
          {
            jobId: nameJob,
            natBaseUrl: 'http://127.0.0.1:1',
            executionMode: 'stream',
            messages: [],
            userId,
            conversationId: namedConversation,
            conversationName: 'Weather in Oslo',
          },
          'Backend stream returned 503',
        );
        expect((await redis.jsonGet(conversationKey)).name).toBe(
          'Weather in Oslo',
        );
      } finally {
        await client.del(
          statusKey,
          conversationKey,
          state.finalizationJournalKey(nameJob),
          state.finalizerLockKey(nameJob),
          state.abortKey(nameJob),
        );
      }
    });

    it.each(['switch', 'delete'])(
      'preserves a concurrent selection %s while applying a terminal conversation',
      async (action) => {
        const selectedKey = redis.sessionKey([
          'user',
          userId,
          'selectedConversation',
        ]);
        const raceJob = `${jobId}-${action}`;
        const statusKey = redis.sessionKey(['async-job-status', raceJob]);
        const replacement = {
          id: 'another-conversation',
          name: 'Chosen elsewhere',
          messages: [],
        };
        await redis.jsonSetWithExpiry(
          selectedKey,
          { id: conversationId, messages: [] },
          120,
        );
        await redis.jsonSetWithExpiry(
          statusKey,
          { jobId: raceJob, status: 'streaming', createdAt: 1 },
          120,
        );
        await state.claimTerminalJobStatus(
          raceJob,
          { status: 'error', finalizedAt: 2 },
          {
            version: 1,
            state: 'pending',
            jobId: raceJob,
            finalizationId: raceJob,
            outcome: 'error',
            userId,
            finalizedAt: 2,
            conversation: {
              id: conversationId,
              name: 'Finished',
              messages: [],
              assistantMessageId: raceJob,
              content: 'Partial response',
              intermediateSteps: [],
              isPartial: true,
            },
          },
        );
        let injected = false;
        const changeSelection = async () => {
          injected = true;
          if (action === 'delete') await client.del(selectedKey);
          else await redis.jsonSetWithExpiry(selectedKey, replacement, 120);
        };
        const call = client.call.bind(client);
        const evaluate = client.eval.bind(client);
        // Inject at the Redis read boundary, after returning its old snapshot.
        // Cover the former JSON.GET and the atomic helper's snapshot read.
        const callSpy = vi
          .spyOn(client, 'call')
          .mockImplementation(async (...args: any[]) => {
            const result = await call(...args);
            if (!injected && args[0] === 'JSON.GET' && args[1] === selectedKey)
              await changeSelection();
            return result;
          });
        const evalSpy = vi
          .spyOn(client, 'eval')
          .mockImplementation(async (...args: any[]) => {
            const result = await evaluate(...args);
            if (!injected && args[2] === selectedKey && Array.isArray(result))
              await changeSelection();
            return result;
          });
        try {
          expect(await finalization.resumePendingFinalization(raceJob)).toBe(
            'completed',
          );
          expect(injected).toBe(true);
          expect(await redis.jsonGet(selectedKey)).toEqual(
            action === 'delete' ? null : replacement,
          );
          expect(
            (
              await redis.jsonGet(
                redis.sessionKey(['conversation', conversationId]),
              )
            ).messages[0].content,
          ).toBe('Partial response');
        } finally {
          callSpy.mockRestore();
          evalSpy.mockRestore();
          await client.del(
            statusKey,
            state.finalizationJournalKey(raceJob),
            state.finalizerLockKey(raceJob),
          );
        }
      },
    );
  },
);
