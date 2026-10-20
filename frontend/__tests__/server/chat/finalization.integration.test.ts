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

    // Durable journal contents, as written.
    const journalOf = async (job: string) => {
      const raw = await client.get(state.finalizationJournalKey(job));
      return raw ? JSON.parse(raw) : null;
    };
    const claimTerminal = async (
      ...args: Parameters<typeof state.claimTerminalJobStatus>
    ) => (await state.claimTerminalJobStatus(...args)).claimed;
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
          res.writeHead(502, { 'Content-Type': 'text/html' });
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
            conversationGuard.conversationJobGuardKey(userId, conversationId),
            redis.sessionKey(['memory-retention', 'record', 'v1', jobId]),
            redis.sessionKey(['memory-retention', 'submission', 'v1', jobId]),
            redis.sessionKey(['memory-retention', 'user', userId, 'v1']),
          )
          .catch(() => 0);
        await client.zrem(
          redis.sessionKey(['memory-retention', 'queue', 'v1']),
          jobId,
        );
        await client.zrem(
          redis.sessionKey(['memory-retention', 'submission-queue', 'v1']),
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
        claimTerminal(
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
        claimTerminal(
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
      const pending = await journalOf(jobId);
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

      const completed = await journalOf(jobId);
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

      // Redis replies to PING on the subscriber connection only after it has
      // delivered every message published before it; a fixed sleep does not.
      await subscriber.ping();
      const completionEventsBeforeRetry = observedMessages.filter(
        ({ payload }) => payload.type === 'chat_complete',
      );
      expect(completionEventsBeforeRetry).toHaveLength(1);
      const eventsPublishedAt = completed?.eventsPublishedAt;

      await expect(finalization.resumePendingFinalization(jobId)).resolves.toBe(
        'completed',
      );
      await subscriber.ping();
      expect(
        observedMessages.filter(
          ({ payload }) => payload.type === 'chat_complete',
        ),
      ).toHaveLength(1);
      expect((await journalOf(jobId))?.eventsPublishedAt).toBe(
        eventsPublishedAt,
      );
      // Finalization only queues retention; the worker's poll sends it once.
      expect(memoryRequests).toHaveLength(0);
      // Other test files share this Redis and its retention queue, so process
      // only this job.
      const { processMemoryRetention } = await import(
        '@/server/chat/memoryRetention'
      );
      await processMemoryRetention(jobId);
      expect(memoryRequests).toHaveLength(successClaimed ? 1 : 0);
      if (successClaimed) expect(memoryRequests[0].request_id).toBe(jobId);
      // The accepted turn's text is gone, so nothing can send it again.
      expect(
        await client.exists(
          redis.sessionKey(['memory-retention', 'submission', 'v1', jobId]),
        ),
      ).toBe(0);
    });

    // The journal carries the whole conversation history. The conversation
    // receipt, guard releases, cleanup, completion and retention queueing are
    // one journal write, so a failure leaves all of them for a retry and a
    // guard is never released before the receipt is durable.
    it('commits the receipt with guard release, cleanup and completion in one journal write', async () => {
      const batchedJob = `${jobId}-batched`;
      const batchedConversation = `${conversationId}-batched`;
      const tokens = `user:${userId}:chat:${batchedConversation}:tokens`;
      const { reserveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      const userGuard = await import('@/server/chat/userJobGuard');
      const streamingKey = redis.sessionKey([
        'streaming',
        'user',
        userId,
        'conversation',
        batchedConversation,
      ]);
      const guardKey = conversationGuard.conversationJobGuardKey(
        userId,
        batchedConversation,
      );
      const evaluate = client.eval.bind(client);
      const isJournalWrite = (script: unknown) =>
        String(script).includes('UPDATE_FINALIZATION_JOURNAL');
      let journalWrites = 0;
      let fault: 'before' | 'after' | null = 'before';
      const evalSpy = vi
        .spyOn(client, 'eval')
        .mockImplementation(async (...args: any[]) => {
          if (!isJournalWrite(args[0])) return evaluate(...args);
          journalWrites += 1;
          const injected = fault;
          fault = null;
          if (injected === 'before') throw new Error('journal write failed');
          const result = await evaluate(...args);
          if (injected === 'after')
            throw new Error('Response lost after Redis committed');
          return result;
        });
      const completions = () =>
        observedMessages.filter(
          ({ payload }) =>
            payload.type === 'chat_complete' && payload.jobId === batchedJob,
        );
      try {
        await subscriber.subscribe(tokens);
        await reserveConversationForUser(userId, batchedConversation);
        await redis.jsonSetWithExpiry(
          redis.sessionKey(['async-job-status', batchedJob]),
          { jobId: batchedJob, status: 'streaming', createdAt: 1 },
          3600,
        );
        await redis.setStreamingState(userId, batchedConversation, batchedJob);
        await conversationGuard.acquireConversationJobGuard(
          userId,
          batchedConversation,
          batchedJob,
          client,
        );
        await userGuard.acquireUserJobGuard(userId, batchedJob, client);
        await streamState.appendStreamResponseDelta(batchedJob, 'partial', 0);
        expect(
          await claimTerminal(
            batchedJob,
            { status: 'error', error: 'Stopped', finalizedAt: 2 },
            {
              version: 1,
              state: 'pending',
              jobId: batchedJob,
              finalizationId: `${batchedJob}-final`,
              outcome: 'error',
              userId,
              finalizedAt: 2,
              conversation: {
                id: batchedConversation,
                name: 'Batched',
                messages: [{ id: 'user-b', role: 'user', content: 'hello' }],
                assistantMessageId: 'assistant-b',
                content: 'partial',
                intermediateSteps: [],
                isPartial: true,
                error: 'Stopped',
              },
            },
          ),
        ).toBe(true);

        // The conversation is saved, but the write recording it fails: no
        // receipt, so the guard and slot stay held and nothing is published.
        await expect(
          finalization.resumePendingFinalization(batchedJob),
        ).rejects.toThrow('journal write failed');
        const interrupted = await journalOf(batchedJob);
        expect(interrupted?.conversationAppliedAt).toBeUndefined();
        expect(interrupted?.eventsPublishedAt).toBeUndefined();
        expect(await client.exists(guardKey, streamingKey)).toBe(2);
        expect(
          await client.zscore(userGuard.userJobGuardKey(userId), batchedJob),
        ).not.toBeNull();
        expect(
          (
            await redis.jsonGet(
              redis.sessionKey(['conversation', batchedConversation]),
            )
          ).messages.at(-1).content,
        ).toBe('partial');

        // The retry commits but its reply is lost; the next resume sees the
        // completed journal and publishes nothing again.
        fault = 'after';
        await expect(
          finalization.resumePendingFinalization(batchedJob),
        ).rejects.toThrow('Response lost');
        await expect(
          finalization.resumePendingFinalization(batchedJob),
        ).resolves.toBe('completed');
        expect(journalWrites).toBe(2);
        const completed = await journalOf(batchedJob);
        expect(completed).toMatchObject({
          state: 'completed',
          conversationAppliedAt: completed?.eventsPublishedAt,
          streamingStateClearedAt: completed?.eventsPublishedAt,
          streamStateClearedAt: completed?.eventsPublishedAt,
          conversationGuardReleasedAt: completed?.eventsPublishedAt,
          completedAt: completed?.eventsPublishedAt,
        });
        expect(
          await client.exists(
            streamingKey,
            streamState.streamResponseKey(batchedJob),
            guardKey,
          ),
        ).toBe(0);
        expect(
          await client.zscore(userGuard.userJobGuardKey(userId), batchedJob),
        ).toBeNull();
        await subscriber.ping();
        expect(completions()).toHaveLength(1);
      } finally {
        evalSpy.mockRestore();
        await subscriber.unsubscribe(tokens);
        await client.del(
          redis.sessionKey(['async-job-status', batchedJob]),
          state.finalizationJournalKey(batchedJob),
          state.finalizerLockKey(batchedJob),
          state.abortKey(batchedJob),
          redis.sessionKey(['conversation', batchedConversation]),
          streamingKey,
          streamState.streamResponseKey(batchedJob),
          guardKey,
          userGuard.userJobGuardKey(userId),
        );
      }
    });

    it('fences a delayed finalizer after its lock expires and a later turn saves', async () => {
      const delayedJob = `${jobId}-expired-lock`;
      const delayedConversation = `${conversationId}-expired-lock`;
      const conversationKey = redis.sessionKey([
        'conversation',
        delayedConversation,
      ]);
      const { reserveConversationForUser, saveConversationForUser } =
        await import('@/server/session/conversationStore');
      await reserveConversationForUser(userId, delayedConversation);
      await redis.jsonSetWithExpiry(
        redis.sessionKey(['async-job-status', delayedJob]),
        { jobId: delayedJob, status: 'streaming', createdAt: 1 },
        3600,
      );
      await claimTerminal(
        delayedJob,
        { status: 'error', error: 'Stopped', finalizedAt: 2 },
        {
          version: 1,
          state: 'pending',
          jobId: delayedJob,
          finalizationId: `${delayedJob}-final`,
          outcome: 'error',
          userId,
          finalizedAt: 2,
          conversation: {
            id: delayedConversation,
            name: 'Delayed',
            messages: [{ id: 'user-old', role: 'user', content: 'first' }],
            assistantMessageId: 'assistant-old',
            content: 'old answer',
            intermediateSteps: [],
            isPartial: true,
            error: 'Stopped',
          },
        },
      );

      let releaseWrite!: () => void;
      let reachedWrite!: () => void;
      const blockedWrite = new Promise<void>(
        (resolve) => (releaseWrite = resolve),
      );
      const writeStarted = new Promise<void>(
        (resolve) => (reachedWrite = resolve),
      );
      const evaluate = client.eval.bind(client);
      let delayed = false;
      const evalSpy = vi
        .spyOn(client, 'eval')
        .mockImplementation(async (...args: any[]) => {
          if (
            !delayed &&
            String(args[0]).includes('SAVE_OWNED_CONVERSATION') &&
            args.includes(conversationKey)
          ) {
            delayed = true;
            reachedWrite();
            await blockedWrite;
          }
          return evaluate(...args);
        });
      const first = finalization.resumePendingFinalization(delayedJob);
      // Keep a rejected first finalizer observed while the second runs.
      const firstSettled = Promise.allSettled([first]);
      try {
        await writeStarted;
        // Expire the real Redis lock without a 30-second wall-clock sleep.
        await client.pexpire(state.finalizerLockKey(delayedJob), 0);
        await expect(
          finalization.resumePendingFinalization(delayedJob),
        ).resolves.toBe('completed');
        await saveConversationForUser(
          userId,
          delayedConversation,
          (current) => ({
            ...current,
            messages: [
              ...current!.messages,
              { id: 'user-new', role: 'user', content: 'follow-up' },
              { id: 'assistant-new', role: 'assistant', content: 'new answer' },
            ],
          }),
        );
        releaseWrite();
        await firstSettled;
        expect(
          (await redis.jsonGet(conversationKey)).messages.map(
            (message: any) => message.id,
          ),
        ).toEqual(['user-old', 'assistant-old', 'user-new', 'assistant-new']);
      } finally {
        releaseWrite();
        await firstSettled;
        evalSpy.mockRestore();
        await client.del(
          redis.sessionKey(['async-job-status', delayedJob]),
          state.finalizationJournalKey(delayedJob),
          state.finalizerLockKey(delayedJob),
          conversationKey,
        );
        await client.srem(
          redis.sessionKey(['user', userId, 'conversations']),
          delayedConversation,
        );
      }
    });

    it.each(['normal', 'recovery', 'deleted'])(
      'respects saved conversation state during %s finalization',
      async (mode) => {
        const { saveConversationForUser } = await import(
          '@/server/session/conversationStore'
        );
        const renameJob = `${jobId}-rename-${mode}`;
        const renamedConversation = `${conversationId}-rename-${mode}`;
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
        const userMessage = {
          id: 'rename-user',
          role: 'user',
          content: 'Plan',
        };
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
        await saveConversationForUser(
          userId,
          renamedConversation,
          (current) => ({
            ...current,
            name: 'Trip plan for March',
            folderId: 'travel',
            updatedAt: Date.now(),
          }),
        );
        await redis.jsonSetWithExpiry(
          selectedKey,
          {
            id: renamedConversation,
            name: 'Trip plan for March',
            folderId: 'travel',
            messages: [userMessage],
          },
          120,
        );

        try {
          // Fail after the conversation is saved, but before the journal write
          // that records it and publishes completion. Recovery must use the
          // saved metadata.
          const evaluate = client.eval.bind(client);
          const faultSpy = vi
            .spyOn(client, 'eval')
            .mockImplementation(async (...args: any[]) => {
              if (
                mode !== 'normal' &&
                String(args[0]).includes('UPDATE_FINALIZATION_JOURNAL') &&
                args.includes(renameJob)
              ) {
                throw new Error('Injected cleanup outage');
              }
              return evaluate(...args);
            });
          const finish = finalization.finalizeSuccess(
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
          );
          try {
            if (mode !== 'normal') {
              await expect(finish).rejects.toThrow('Injected cleanup outage');
              expect(
                (await journalOf(renameJob))?.conversationAppliedAt,
              ).toBeUndefined();
              expect(
                (await redis.jsonGet(conversationKey)).messages.map(
                  (message: any) => message.id,
                ),
              ).toEqual(['rename-user', 'rename-assistant']);
            } else {
              await expect(finish).resolves.toBe(true);
            }
          } finally {
            faultSpy.mockRestore();
          }
          if (mode === 'deleted') {
            const { deleteConversationForUser } = await import(
              '@/server/session/conversationDeletion'
            );
            await expect(
              deleteConversationForUser(userId, renamedConversation),
            ).resolves.toBe(true);
          }
          if (mode !== 'normal') {
            await expect(
              finalization.resumePendingFinalization(renameJob),
            ).resolves.toBe('completed');
          }

          const saved = await redis.jsonGet(conversationKey);
          if (mode === 'deleted') {
            expect(saved).toBeNull();
            await subscriber.ping();
            expect(
              observedMessages.filter(
                ({ payload }) =>
                  payload.type === 'conversation_updated' &&
                  payload.data?.conversationId === renamedConversation,
              ),
            ).toEqual([]);
            expect(
              memoryRequests.filter(
                (request) => request.request_id === renameJob,
              ),
            ).toEqual([]);
            expect(await journalOf(renameJob)).toMatchObject({
              state: 'completed',
              conversationSuppressedAt: expect.any(Number),
            });
            return;
          }
          expect(saved.name).toBe('Trip plan for March');
          expect(saved.folderId).toBe('travel');
          expect(saved.messages.map((message: any) => message.id)).toEqual([
            'rename-user',
            'rename-assistant',
          ]);
          // A finished turn never rewrites the selection pointer.
          expect(await redis.jsonGet(selectedKey)).toEqual({
            id: renamedConversation,
            name: 'Trip plan for March',
            folderId: 'travel',
            messages: [userMessage],
          });
          await subscriber.ping();
          const updates = observedMessages.filter(
            ({ payload }) =>
              payload.type === 'conversation_updated' &&
              payload.data?.conversationId === renamedConversation,
          );
          expect(updates.at(-1)?.payload.data.conversation.name).toBe(
            'Trip plan for March',
          );
          expect(updates.at(-1)?.payload.data.conversation.folderId).toBe(
            'travel',
          );
        } finally {
          await client.del(
            statusKey,
            conversationKey,
            state.finalizationJournalKey(renameJob),
            state.finalizerLockKey(renameJob),
            state.abortKey(renameJob),
            redis.sessionKey(['memory-retention', 'record', 'v1', renameJob]),
            redis.sessionKey([
              'memory-retention',
              'submission',
              'v1',
              renameJob,
            ]),
          );
          await client.zrem(
            redis.sessionKey(['memory-retention', 'queue', 'v1']),
            renameJob,
          );
          await client.zrem(
            redis.sessionKey(['memory-retention', 'submission-queue', 'v1']),
            renameJob,
          );
        }
      },
    );

    it('completes without the memory service and releases an unread failure response when retention runs', async () => {
      const retainJob = `${jobId}-retain-failure`;
      const retainConversation = `${conversationId}-retain-failure`;
      const statusKey = redis.sessionKey(['async-job-status', retainJob]);
      const conversationKey = redis.sessionKey([
        'conversation',
        retainConversation,
      ]);
      const submissionKey = redis.sessionKey([
        'memory-retention',
        'submission',
        'v1',
        retainJob,
      ]);
      const { reserveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      const { processMemoryRetention } = await import(
        '@/server/chat/memoryRetention'
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
      const before = memoryRequests.length;
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
        // Completion never waited for the (unavailable) memory service.
        expect(memoryRequests.length).toBe(before);
        expect(await journalOf(retainJob)).toMatchObject({
          state: 'completed',
          memoryRetentionAttemptedAt: expect.any(Number),
        });
        expect(JSON.parse(await client.get(submissionKey))).toMatchObject({
          jobId: retainJob,
          userContent: 'Hi',
          assistantContent: 'Hello.',
          attempts: 0,
        });
        expect(await client.ttl(submissionKey)).toBeGreaterThan(0);

        await processMemoryRetention(retainJob);
        expect(memoryRequests.slice(before)).toEqual([
          expect.objectContaining({ request_id: retainJob }),
        ]);
        await expect(
          Promise.race([
            closed,
            new Promise((resolve) => setTimeout(() => resolve('open'), 1_000)),
          ]),
        ).resolves.toBe('closed');
        // Kept for a later attempt with backoff.
        expect(JSON.parse(await client.get(submissionKey))).toMatchObject({
          attempts: 1,
        });
      } finally {
        memoryUnavailable = false;
        memoryResponseClosed = undefined;
        await client.del(
          statusKey,
          conversationKey,
          submissionKey,
          state.finalizationJournalKey(retainJob),
          state.finalizerLockKey(retainJob),
          state.abortKey(retainJob),
          redis.sessionKey(['memory-retention', 'lock', 'v1', retainJob]),
        );
        await client.zrem(
          redis.sessionKey(['memory-retention', 'queue', 'v1']),
          retainJob,
        );
        await client.zrem(
          redis.sessionKey(['memory-retention', 'submission-queue', 'v1']),
          retainJob,
        );
      }
    });

    it('finalizes a turn in six serial round trips without reading back the journal or selection', async () => {
      const { recordRedisLayers } = await import('../../fixtures/redisLayers');
      const { reserveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      const fastJob = `${jobId}-round-trips`;
      const fastConversation = `${conversationId}-round-trips`;
      const statusKey = redis.sessionKey(['async-job-status', fastJob]);
      const selectedKey = redis.sessionKey([
        'user',
        userId,
        'selectedConversation',
      ]);
      await reserveConversationForUser(userId, fastConversation);
      await redis.jsonSetWithExpiry(
        statusKey,
        { jobId: fastJob, status: 'streaming', createdAt: Date.now() },
        120,
      );
      await redis.jsonSetWithExpiry(selectedKey, { id: fastConversation }, 120);
      await streamState.appendStreamSteps(
        fastJob,
        [{ id: 'step', payload: { event_type: 'TOOL_END' } }],
        0,
      );
      const recorder = recordRedisLayers(client);
      try {
        await expect(
          finalization.finalizeSuccess(
            fastJob,
            {
              jobId: fastJob,
              natBaseUrl: 'http://127.0.0.1:1',
              executionMode: 'stream',
              messages: [{ id: 'fast-user', role: 'user', content: 'Hi' }],
              userId,
              conversationId: fastConversation,
              assistantMessageId: 'fast-answer',
            },
            'Hello.',
          ),
        ).resolves.toBe(true);
      } finally {
        recorder.stop();
      }
      const byLayer = new Map<number, string[]>();
      for (const command of recorder.steady())
        byLayer.set(command.layer, [
          ...(byLayer.get(command.layer) ?? []),
          command.name === 'EVAL' || command.name === 'EVALSHA'
            ? command.tag
            : command.name,
        ]);
      expect([...byLayer.values()].map((layer) => layer.sort())).toEqual([
        ['LRANGE', 'READ_JOB_STATUS_SNAPSHOT'],
        // The winning claim takes the finalizer lock in the same commit.
        ['CLAIM_TERMINAL_FINALIZATION'],
        ['READ_OWNED_CONVERSATION'],
        ['SAVE_OWNED_CONVERSATION'],
        // Receipt, cleanup, guard release, completion, retention queueing.
        ['UPDATE_FINALIZATION_JOURNAL'],
        // The lock release follows chat_complete.
        ['RELEASE_FINALIZATION_LOCK'],
      ]);
      expect(
        recorder.commands.some((command) => command.args.includes(selectedKey)),
      ).toBe(false);
      expect(await journalOf(fastJob)).toMatchObject({
        state: 'completed',
      });
      await client.del(
        statusKey,
        redis.sessionKey(['conversation', fastConversation]),
        redis.sessionKey(['memory-retention', 'submission', 'v1', fastJob]),
        state.finalizationJournalKey(fastJob),
        state.finalizerLockKey(fastJob),
      );
      await client.zrem(
        redis.sessionKey(['memory-retention', 'queue', 'v1']),
        fastJob,
      );
      await client.zrem(
        redis.sessionKey(['memory-retention', 'submission-queue', 'v1']),
        fastJob,
      );
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

    it('leaves the selection pointer untouched while applying a terminal conversation', async () => {
      const selectedKey = redis.sessionKey([
        'user',
        userId,
        'selectedConversation',
      ]);
      const raceJob = `${jobId}-selection`;
      const statusKey = redis.sessionKey(['async-job-status', raceJob]);
      // An older pointer that still carries a conversation copy.
      const pointer = { id: conversationId, name: 'Old', messages: [] };
      await redis.jsonSetWithExpiry(selectedKey, pointer, 120);
      await redis.jsonSetWithExpiry(
        statusKey,
        { jobId: raceJob, status: 'streaming', createdAt: 1 },
        120,
      );
      await claimTerminal(
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
      const touched: unknown[][] = [];
      const call = client.call.bind(client);
      const evaluate = client.eval.bind(client);
      const callSpy = vi
        .spyOn(client, 'call')
        .mockImplementation(async (...args: any[]) => {
          if (args.includes(selectedKey)) touched.push(args);
          return call(...args);
        });
      const evalSpy = vi
        .spyOn(client, 'eval')
        .mockImplementation(async (...args: any[]) => {
          if (args.includes(selectedKey)) touched.push(args);
          return evaluate(...args);
        });
      try {
        expect(await finalization.resumePendingFinalization(raceJob)).toBe(
          'completed',
        );
        expect(touched).toEqual([]);
        expect(await redis.jsonGet(selectedKey)).toEqual(pointer);
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
    });
  },
);
