// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const RUN_REAL_REDIS = process.env.RUN_REDIS_STREAM_INTEGRATION === '1';
const cookie = vi.hoisted(() => ({ sid: '' }));
vi.mock('@/server/session/_utils', () => ({
  getOrSetSessionId: () => cookie.sid,
  readSessionId: () => cookie.sid,
  clearSessionCookie: vi.fn(),
  rotateSessionId: vi.fn(),
}));

describe.skipIf(!RUN_REAL_REDIS)('state boundaries in real Redis', () => {
  let redis: typeof import('@/server/session/redis');
  let auth: typeof import('@/utils/auth/session');
  let jobs: typeof import('@/server/chat/jobState');
  let client: ReturnType<typeof redis.getRedis>;
  const keys = new Set<string>();
  let serial = 0;
  const id = () => `audit-${process.pid}-${Date.now()}-${serial++}`;

  beforeAll(async () => {
    if (!process.env.REDIS_URL)
      throw new Error('Disposable REDIS_URL required');
    redis = await import('@/server/session/redis');
    auth = await import('@/utils/auth/session');
    jobs = await import('@/server/chat/jobState');
    client = redis.getRedis();
    await client.ping();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (client) {
      if (keys.size) await client.del(...keys);
      client.disconnect();
    }
  });

  // Both representations are supported at runtime, including old string keys
  // in a RedisJSON installation. Seed directly so setup cannot mask migrations.
  async function seed(key: string, value: object, json: boolean) {
    keys.add(key);
    if (json) await client.call('JSON.SET', key, '$', JSON.stringify(value));
    else await client.set(key, JSON.stringify(value));
    await client.expire(key, 120);
  }

  it.each([false, true])(
    'retries stream writes exactly once when failure follows commit=%s',
    async (committed) => {
      const state = await import('@/server/chat/streamState');
      const jobId = id();
      keys.add(state.streamResponseKey(jobId));
      keys.add(state.streamStepsKey(jobId));
      const evaluate = client.eval.bind(client);
      const delta = 'First 🌍';
      const steps = [
        { id: 'one', values: [] },
        { id: 'two', n: 7 },
      ];
      for (const write of [
        () => state.appendStreamResponseDelta(jobId, delta, 0),
        () => state.appendStreamSteps(jobId, steps, 0),
      ]) {
        vi.spyOn(client, 'eval').mockImplementationOnce(
          async (...args: any[]) => {
            if (committed)
              await evaluate(...(args as [string, number, ...any[]]));
            throw new Error('Redis response lost');
          },
        );
        await expect(write()).rejects.toThrow('Redis response lost');
        await write();
      }
      expect(await client.get(state.streamResponseKey(jobId))).toBe(delta);
      expect(
        (await client.lrange(state.streamStepsKey(jobId), 0, -1)).map((value) =>
          JSON.parse(value),
        ),
      ).toEqual(steps);
    },
  );

  it('reads legacy string JSON without reconnecting on expected type errors', async () => {
    const key = id();
    await seed(key, { user: 'alice', values: [] }, false);
    const reconnecting = vi.fn();
    client.on('reconnecting', reconnecting);
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect(await redis.jsonGet(key)).toEqual({ user: 'alice', values: [] });
      }
      expect(reconnecting).not.toHaveBeenCalled();
    } finally {
      client.off('reconnecting', reconnecting);
    }
  });

  it('fences a previous stream owner after lease replacement', async () => {
    const queue = await import('@/server/chat/streamQueue');
    const jobId = id();
    const leaseKey = queue.streamLeaseKey(jobId);
    const startedKey = queue.streamBackendStartedKey(jobId);
    keys.add(leaseKey);
    keys.add(startedKey);
    expect(
      await queue.acquireStreamLease(jobId, 'old-owner', 1000, client),
    ).toBe(true);
    expect(
      await queue.acquireStreamLease(jobId, 'replacement', 1000, client),
    ).toBe(false);
    expect(await queue.renewStreamLease(jobId, 'old-owner', 1000, client)).toBe(
      true,
    );
    await client.pexpire(leaseKey, 0);
    expect(
      await queue.acquireStreamLease(jobId, 'replacement', 1000, client),
    ).toBe(true);
    expect(await queue.renewStreamLease(jobId, 'old-owner', 1000, client)).toBe(
      false,
    );
    expect(await queue.releaseStreamLease(jobId, 'old-owner', client)).toBe(
      false,
    );
    expect(
      await queue.markBackendRequestStarted(jobId, 'old-owner', client),
    ).toBe(false);
    expect(await client.exists(startedKey)).toBe(0);
    expect(await client.get(leaseKey)).toBe('replacement');
    expect(
      await queue.markBackendRequestStarted(jobId, 'replacement', client),
    ).toBe(true);
    expect(await queue.releaseStreamLease(jobId, 'replacement', client)).toBe(
      true,
    );
    expect(await client.exists(leaseKey)).toBe(0);
  });

  it('matches an ordered-stream reference across retries, overlaps, gaps, and conflicts', async () => {
    const state = await import('@/server/chat/streamState');
    let randomState = 0x31415926;
    const random = () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState >>> 16;
    };
    for (let run = 0; run < 48; run++) {
      const jobId = id();
      const responseKey = state.streamResponseKey(jobId);
      const stepsKey = state.streamStepsKey(jobId);
      keys.add(responseKey);
      keys.add(stepsKey);
      const tokens = Array.from(
        { length: 5 + (random() % 7) },
        (_, index) => `${index}:${['🌍', 'é', 'longer', 'x'][random() % 4]} `,
      );
      const steps = tokens.map((value, index) => ({
        id: index,
        value,
        empty: [],
      }));
      // Expected data is the declared ordered sequence, independent of retries
      // and batch boundaries. Include older retries after subsequent progress.
      let end = 0;
      while (end < tokens.length) {
        const start = Math.max(0, end - (random() % 3));
        end = Math.min(tokens.length, end + 1 + (random() % 3));
        const offset = new TextEncoder().encode(
          tokens.slice(0, start).join(''),
        ).length;
        await state.appendStreamResponseDelta(
          jobId,
          tokens.slice(start, end).join(''),
          offset,
        );
        await state.appendStreamSteps(jobId, steps.slice(start, end), start);
        await state.appendStreamResponseDelta(jobId, tokens[0], 0);
        await state.appendStreamSteps(jobId, [steps[0]], 0);
        expect(await client.get(responseKey)).toBe(
          tokens.slice(0, end).join(''),
        );
        expect(
          (await client.lrange(stepsKey, 0, -1)).map((value) =>
            JSON.parse(value),
          ),
        ).toEqual(steps.slice(0, end));
      }
      const full = tokens.join('');
      const byteLength = new TextEncoder().encode(full).length;
      await expect(
        state.appendStreamResponseDelta(jobId, 'wrong', byteLength - 1),
      ).rejects.toThrow('conflict');
      await expect(
        state.appendStreamResponseDelta(jobId, 'gap', byteLength + 1),
      ).rejects.toThrow('gap');
      await expect(
        state.appendStreamSteps(jobId, [{ id: 'wrong' }], steps.length - 1),
      ).rejects.toThrow('conflict');
      await expect(
        state.appendStreamSteps(jobId, [{ id: 'gap' }], steps.length + 1),
      ).rejects.toThrow('gap');
      expect(await client.get(responseKey)).toBe(full);
      expect(
        (await client.lrange(stepsKey, 0, -1)).map((value) =>
          JSON.parse(value),
        ),
      ).toEqual(steps);
      expect(await client.ttl(responseKey)).toBeGreaterThan(0);
      expect(await client.ttl(stepsKey)).toBeGreaterThan(0);
    }
  });

  it('retains concurrent journal phases and publishes once after a lost response', async () => {
    const jobId = id();
    const key = jobs.finalizationJournalKey(jobId);
    keys.add(key);
    const initial = {
      version: 1,
      state: 'pending',
      jobId,
      finalizationId: id(),
      userId: 'alice',
      outcome: 'completed',
      finalizedAt: 1,
    };
    await client.set(key, JSON.stringify(initial), 'EX', 120);
    await Promise.all([
      jobs.markFinalizationPhase(
        jobId,
        initial.finalizationId,
        'conversationAppliedAt',
        0,
      ),
      jobs.markFinalizationPhase(
        jobId,
        initial.finalizationId,
        'streamingStateClearedAt',
        5,
      ),
      jobs.setMemoryRetentionReceipt(jobId, initial.finalizationId, {
        operationId: 'first',
        acceptedAt: 7,
      }),
    ]);
    await jobs.markFinalizationPhase(
      jobId,
      initial.finalizationId,
      'conversationAppliedAt',
      99,
    );
    await jobs.setMemoryRetentionReceipt(jobId, initial.finalizationId, {
      operationId: 'second',
      acceptedAt: 99,
    });
    const before = await jobs.getFinalizationJournal(jobId);
    expect(before).toEqual({
      ...initial,
      conversationAppliedAt: 0,
      streamingStateClearedAt: 5,
      memoryRetention: { operationId: 'first', acceptedAt: 7 },
    });
    expect(
      await jobs.markFinalizationPhase(jobId, 'stale-owner', 'completedAt', 11),
    ).toBeNull();
    expect(await jobs.getFinalizationJournal(jobId)).toEqual(before);

    const subscriber = client.duplicate();
    const channel = `audit:${jobId}`;
    const delivered: string[] = [];
    subscriber.on('message', (_channel, payload) => delivered.push(payload));
    await subscriber.subscribe(channel);
    try {
      const evaluate = client.eval.bind(client);
      vi.spyOn(client, 'eval').mockImplementationOnce(
        async (...args: any[]) => {
          await evaluate(...(args as [string, number, ...any[]]));
          throw new Error('Response lost after Redis committed');
        },
      );
      await expect(
        jobs.publishFinalizationEvents(
          jobId,
          initial.finalizationId,
          [{ channel, payload: 'first event' }],
          13,
        ),
      ).rejects.toThrow('Response lost');
      await jobs.publishFinalizationEvents(
        jobId,
        initial.finalizationId,
        [{ channel, payload: 'duplicate event' }],
        99,
      );
      await subscriber.ping();
      expect(delivered).toEqual(['first event']);
      expect(await jobs.getFinalizationJournal(jobId)).toEqual({
        ...before,
        eventsPublishedAt: 13,
      });
    } finally {
      subscriber.disconnect();
    }
  });

  for (const json of [false, true]) {
    describe(json ? 'RedisJSON' : 'plain string', () => {
      it.each(['claim', 'phase', 'receipt', 'events'] as const)(
        'preserves JSON arrays, objects, and exact integers through journal %s',
        async (operation) => {
          const jobId = id();
          const key = redis.sessionKey(['async-job-status', jobId]);
          const journalKey = jobs.finalizationJournalKey(jobId);
          keys.add(journalKey);
          keys.add(redis.sessionKey(['async-job-status-lock', jobId]));
          const steps = [
            {
              empty: [],
              object: {},
              nested: [[]],
              exact: 9007199254740991,
              adjacent: 9007199254740990,
            },
          ];
          const terminal = {
            jobId,
            status: 'completed' as const,
            createdAt: 1,
            updatedAt: 3,
            finalizedAt: 3,
            intermediateSteps: steps,
          };
          const journal = {
            version: 1 as const,
            state: 'pending' as const,
            jobId,
            finalizationId: id(),
            userId: 'alice',
            outcome: 'completed' as const,
            finalizedAt: 3,
            conversation: {
              id: 'conversation',
              name: 'Test',
              messages: [],
              assistantMessageId: 'answer',
              content: 'Done',
              intermediateSteps: steps,
              isPartial: false,
            },
          };
          if (operation === 'claim') {
            await seed(
              key,
              { jobId, status: 'streaming', createdAt: 1, updatedAt: 2 },
              json,
            );
            expect(
              await jobs.claimTerminalJobStatus(jobId, terminal, journal),
            ).toBe(true);
            expect(await redis.jsonGet(key)).toEqual(terminal);
          } else {
            await client.set(
              journalKey,
              JSON.stringify({ ...journal, terminalStatus: terminal }),
              'EX',
              120,
            );
            if (operation === 'phase')
              await jobs.markFinalizationPhase(
                jobId,
                journal.finalizationId,
                'conversationAppliedAt',
                7,
              );
            if (operation === 'receipt')
              await jobs.setMemoryRetentionReceipt(
                jobId,
                journal.finalizationId,
                { operationId: 'op', acceptedAt: 7 },
              );
            if (operation === 'events')
              await jobs.publishFinalizationEvents(
                jobId,
                journal.finalizationId,
                [{ channel: `audit:${jobId}`, payload: 'done' }],
                7,
              );
          }
          const stored = await jobs.getFinalizationJournal(jobId);
          expect(stored?.conversation).toEqual(journal.conversation);
          expect(stored?.terminalStatus).toEqual(terminal);
        },
      );

      it('retains a newer activity timestamp when an older refresh resumes', async () => {
        const now = 1_800_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        cookie.sid = id();
        const key = redis.sessionKey(['auth-session', cookie.sid]);
        const old = {
          userId: 'alice',
          username: 'alice',
          name: 'Alice',
          loginTime: 1,
          lastActivity: now - 60_001,
        };
        const newer = { ...old, name: 'Alice updated', lastActivity: now + 7 };
        await seed(key, old, json);
        const get = redis.jsonGet;
        vi.spyOn(redis, 'jsonGet').mockImplementationOnce(async (readKey) => {
          const snapshot = await get(readKey);
          await seed(key, newer, json);
          return snapshot;
        });
        expect(await auth.getSession({} as any, {} as any)).toEqual(newer);
        expect(await get(key)).toEqual(newer);
        expect(await client.ttl(key)).toBeLessThanOrEqual(120);
      });

      it('retries a conflicting live snapshot without losing unrelated fields or JSON array shapes', async () => {
        const jobId = id();
        const key = redis.sessionKey(['async-job-status', jobId]);
        const initial = {
          jobId,
          status: 'streaming',
          createdAt: 1,
          updatedAt: 2,
          intermediateSteps: [{ arrays: [[], { list: [] }], object: {} }],
        };
        await seed(key, initial, json);
        const evaluate = client.eval.bind(client);
        vi.spyOn(client, 'eval').mockImplementationOnce(
          async (...args: any[]) => {
            const snapshot = await evaluate(
              ...(args as [string, number, ...any[]]),
            );
            await seed(
              key,
              { ...initial, partialResponse: 'another writer' },
              json,
            );
            return snapshot;
          },
        );
        await jobs.updateJobStatus(jobId, { progress: 37 });
        expect(await redis.jsonGet(key)).toEqual({
          ...initial,
          partialResponse: 'another writer',
          progress: 37,
        });
      });

      it('consumes concurrent OAuth callbacks independently, including duplicate and unknown states', async () => {
        const jobId = id();
        const key = redis.sessionKey(['async-job-status', jobId]);
        await seed(
          key,
          {
            jobId,
            status: 'oauth_required',
            createdAt: 1,
            updatedAt: 2,
            authUrl: 'https://example.test/docs',
            oauthState: 'docs',
            oauthRequests: ['docs', 'calendar'].map((state) => ({
              id: state,
              oauthState: state,
              authUrl: `https://example.test/${state}`,
            })),
          },
          json,
        );
        const outcomes = await Promise.all(
          ['docs', 'calendar', 'docs', 'unknown'].map((state) =>
            jobs.completeOAuthJobRequest(jobId, state),
          ),
        );
        expect(outcomes.filter(Boolean)).toHaveLength(2);
        expect(outcomes[1]).toBe(true);
        expect(outcomes[3]).toBe(false);
        const status = await redis.jsonGet(key);
        expect(status.status).toBe('streaming');
        expect(status.authUrl).toBeUndefined();
        expect(status.oauthState).toBeUndefined();
        expect(status.oauthRequests).toBeUndefined();
      });

      it('matches the first-terminal-outcome law across structured randomized schedules', async () => {
        // Independent reference: the first terminal event fixes the outcome;
        // a later deletion leaves no state. Generate schedules with useful
        // writes on BOTH sides of that boundary, including competing endings.
        let randomState = 0x9a71c0de;
        const choose = (limit: number) => {
          randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
          return (randomState >>> 8) % limit;
        };
        const readStatus = async (key: string) =>
          JSON.parse(
            String(
              json
                ? await client.call('JSON.GET', key, '.')
                : await client.get(key),
            ),
          );
        const outcomes = new Set<string>();
        for (let sample = 0; sample < 48; sample += 1) {
          const jobId = id();
          const key = redis.sessionKey(['async-job-status', jobId]);
          keys.add(jobs.finalizationJournalKey(jobId));
          keys.add(redis.sessionKey(['async-job-status-lock', jobId]));
          await seed(
            key,
            { jobId, status: 'streaming', createdAt: 1, updatedAt: 2 },
            json,
          );
          const boundary = 1 + choose(4);
          const outcome = choose(2) ? 'completed' : 'error';
          outcomes.add(outcome);
          const attempts: boolean[] = [];
          let terminalSnapshot: object | undefined;
          for (let step = 0; step < boundary + 5; step += 1) {
            if (step === boundary || step === boundary + 2) {
              const requested =
                step === boundary
                  ? outcome
                  : outcome === 'error'
                  ? 'completed'
                  : 'error';
              attempts.push(
                await jobs.claimTerminalJobStatus(
                  jobId,
                  {
                    status: requested,
                    finalizedAt: step,
                    updatedAt: step,
                  },
                  {
                    version: 1,
                    state: 'pending',
                    jobId,
                    finalizationId: id(),
                    userId: 'alice',
                    outcome: requested,
                    finalizedAt: step,
                  },
                ),
              );
              if (step === boundary) terminalSnapshot = await readStatus(key);
            } else {
              const progress = choose(101);
              await jobs.updateJobStatus(
                jobId,
                choose(2) ? { progress } : { status: 'streaming', progress },
              );
            }
            if (step >= boundary)
              expect(await readStatus(key)).toEqual(terminalSnapshot);
          }
          expect(attempts).toEqual([true, false]);
          expect(await readStatus(key)).toMatchObject({
            status: outcome,
            finalizedAt: boundary,
          });
          await client.del(key);
          await jobs.updateJobStatus(jobId, { status: 'pending', progress: 1 });
          expect(await client.exists(key)).toBe(0);
        }
        expect(outcomes.size).toBe(2);
      }, 30_000);

      it('cannot overwrite finalization after a status-update lease expires', async () => {
        const jobId = id();
        const key = redis.sessionKey(['async-job-status', jobId]);
        const lockKey = redis.sessionKey(['async-job-status-lock', jobId]);
        keys.add(lockKey);
        keys.add(jobs.finalizationJournalKey(jobId));
        await seed(
          key,
          { jobId, status: 'streaming', createdAt: 1, updatedAt: 2 },
          json,
        );
        let resume!: () => void;
        let reached!: () => void;
        const paused = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const release = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const write = redis.jsonSetWithExpiry;
        vi.spyOn(redis, 'jsonSetWithExpiry').mockImplementationOnce(
          async (...args) => {
            reached();
            await release;
            return write(...args);
          },
        );
        const update = jobs.updateJobStatus(jobId, {
          status: 'streaming',
          progress: 37,
        });
        // An indivisible update may finish directly. A read/write update is
        // deliberately paused at its last write, beyond its ownership lease.
        await Promise.race([paused, update]);
        await client.del(lockKey);
        try {
          expect(
            await jobs.claimTerminalJobStatus(
              jobId,
              {
                status: 'error',
                error: 'canceled',
                finalizedAt: 3,
                updatedAt: 3,
              },
              {
                version: 1,
                state: 'pending',
                jobId,
                finalizationId: id(),
                userId: 'alice',
                outcome: 'error',
                finalizedAt: 3,
              },
            ),
          ).toBe(true);
        } finally {
          resume();
          await update;
        }
        expect(await redis.jsonGet(key)).toMatchObject({
          status: 'error',
          error: 'canceled',
          finalizedAt: 3,
          updatedAt: 3,
        });
      });

      for (const remove of ['logout', 'expiry'] as const) {
        it(`activity refresh cannot restore a session removed by ${remove}`, async () => {
          cookie.sid = id();
          const key = redis.sessionKey(['auth-session', cookie.sid]);
          await seed(
            key,
            {
              userId: 'alice',
              username: 'alice',
              name: 'Alice',
              loginTime: 1,
              lastActivity: Date.now() - 60_001,
            },
            json,
          );
          const get = redis.jsonGet;
          vi.spyOn(redis, 'jsonGet').mockImplementationOnce(async (readKey) => {
            const snapshot = await get(readKey);
            if (remove === 'logout')
              await auth.destroySession({} as any, {} as any);
            else await client.pexpire(key, 0);
            return snapshot;
          });

          expect(await auth.getSession({} as any, {} as any)).toBeNull();
          expect(await client.exists(key)).toBe(0);
        });
      }

      for (const elapsed of [59_999, 60_000, 60_001]) {
        it(`refreshes a live session at the documented interval: ${elapsed}ms`, async () => {
          const now = 1_800_000_000_000;
          vi.spyOn(Date, 'now').mockReturnValue(now);
          cookie.sid = id();
          const key = redis.sessionKey(['auth-session', cookie.sid]);
          const session = {
            userId: 'alice',
            username: 'alice',
            name: 'Alice',
            loginTime: 1,
            lastActivity: now - elapsed,
          };
          await seed(key, session, json);
          const result = await auth.getSession({} as any, {} as any);
          const refreshed = elapsed > 60_000;
          expect(result).toEqual({
            ...session,
            lastActivity: refreshed ? now : session.lastActivity,
          });
          expect(await redis.jsonGet(key)).toEqual(result);
          const ttl = await client.ttl(key);
          expect(ttl).toBeGreaterThan(refreshed ? 86_390 : 110);
          expect(ttl).toBeLessThanOrEqual(refreshed ? 86_400 : 120);
          expect(
            String(await client.type(key))
              .toLowerCase()
              .includes('rejson'),
          ).toBe(json);
        });
      }

      for (const terminal of [
        { status: 'completed' },
        { status: 'error' },
        { status: 'streaming', finalizedAt: 0 },
        { status: 'completed', finalizedAt: 123 },
      ]) {
        for (const patch of [
          { progress: 71 },
          { status: 'streaming', progress: 19 },
        ] as const) {
          it(`does not change a terminal record ${JSON.stringify(
            terminal,
          )} with ${JSON.stringify(patch)}`, async () => {
            const jobId = id();
            const key = redis.sessionKey(['async-job-status', jobId]);
            keys.add(redis.sessionKey(['async-job-status-lock', jobId]));
            const status = { jobId, createdAt: 1, updatedAt: 2, ...terminal };
            await seed(key, status, json);
            await jobs.updateJobStatus(jobId, patch);
            expect(await redis.jsonGet(key)).toEqual(status);
            expect(await client.ttl(key)).toBeLessThanOrEqual(120);
          });
        }
      }
    });
  }
});
