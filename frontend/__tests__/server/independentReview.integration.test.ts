// @vitest-environment node
// Expectations were derived in an isolated context without application code.
// This adapter translates names/coordinates; it never calculates expected state.
import { REDIS_CLIENT_OPTIONS } from '@/server/session/redisShared';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const reference = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL(
        '../../../test-fixtures/code-audit-independent-20260909.json.gz',
        import.meta.url,
      ),
    ),
  ).toString(),
);
const cookie = vi.hoisted(() => ({ sid: '' }));
vi.mock('@/server/session/_utils', () => ({
  getOrSetSessionId: () => cookie.sid,
  readSessionId: () => cookie.sid,
  clearSessionCookie: vi.fn(),
  rotateSessionId: vi.fn(),
}));

describe('independently derived Redis error classifications', () => {
  it.each<Record<string, any>>(reference.redis_errors.classifications)(
    '$message',
    (row: any) => {
      expect(
        REDIS_CLIENT_OPTIONS.reconnectOnError!(new Error(row.message)),
      ).toBe(row.reconnect);
    },
  );
});

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'independent contracts in real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let auth: typeof import('@/utils/auth/session');
    let jobs: typeof import('@/server/chat/jobState');
    let stream: typeof import('@/server/chat/streamState');
    let client: ReturnType<typeof redis.getRedis>;
    const keys = new Set<string>();
    let serial = 0;
    const id = () => `independent-${process.pid}-${serial++}`;
    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('Disposable REDIS_URL required');
      redis = await import('@/server/session/redis');
      auth = await import('@/utils/auth/session');
      jobs = await import('@/server/chat/jobState');
      stream = await import('@/server/chat/streamState');
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
    const seed = async (
      key: string,
      value: any,
      json = false,
      ttl = 120000,
    ) => {
      keys.add(key);
      if (json) await client.call('JSON.SET', key, '$', JSON.stringify(value));
      else await client.set(key, JSON.stringify(value));
      await client.pexpire(key, ttl);
    };
    const raw = async (key: string, json = false) => {
      const value = json
        ? await client.call('JSON.GET', key, '.')
        : await client.get(key);
      return value === null ? null : JSON.parse(String(value));
    };

    async function withFault(fault: string, operation: () => Promise<unknown>) {
      // The reference injects failure at the operation boundary, including empty
      // no-ops that make no Redis command. Driver-level lost replies are covered
      // separately by stateBoundaries.integration.test.ts.
      try {
        if (fault === 'before_write') throw new Error(`independent ${fault}`);
        await operation();
        if (fault === 'after_write') throw new Error(`independent ${fault}`);
        return null;
      } catch (error) {
        return error as Error;
      }
    }

    const sequences = [
      ...reference.persistence.scenarios,
      ...reference.persistence.randomized_schedules,
    ];
    it.each(sequences)('ordered persistence: $id', async (scenario: any) => {
      const jobId = id();
      const steps = scenario.coordinate === 'step';
      const key = steps
        ? stream.streamStepsKey(jobId)
        : stream.streamResponseKey(jobId);
      keys.add(key);
      if (scenario.initial.length) {
        if (steps)
          await client.rpush(
            key,
            ...scenario.initial.map((item: any) => JSON.stringify(item)),
          );
        else await client.set(key, scenario.initial.join(''));
      }
      const boundaries =
        scenario.id === 'empty_response_segment'
          ? [0, 0, 2]
          : reference.persistence.response_boundaries.map(
              (value: any) => value.utf8_byte,
            );
      for (const [index, operation] of scenario.operations.entries()) {
        let offset = operation.start;
        let text = steps ? '' : operation.items.join('');
        if (scenario.coordinate === 'segment') {
          offset =
            boundaries[operation.start] ??
            boundaries.at(-1) + operation.start - boundaries.length + 1;
        } else if (scenario.coordinate === 'unicode_scalar') {
          const scalars = Array.from(
            reference.persistence.declared_response_segments.join(''),
          );
          offset =
            Buffer.byteLength(scalars.slice(0, operation.start).join('')) +
            Math.max(0, operation.start - scalars.length);
        } else if (scenario.coordinate === 'utf8_byte') {
          text = Buffer.from(operation.items).toString('utf8');
        }
        const error = await withFault(operation.fault, () =>
          steps
            ? stream.appendStreamSteps(jobId, operation.items, offset)
            : stream.appendStreamResponseDelta(jobId, text, offset),
        );
        const label = `${scenario.id} operation ${index}`;
        const result = operation.expect.result;
        if (result.startsWith('error_'))
          expect(error?.message, label).toBe(`independent ${operation.fault}`);
        else if (result.startsWith('reject_'))
          expect(error?.message, label).toContain(result.slice(7));
        else expect(error, label).toBeNull();
        if (steps) {
          expect(
            (await client.lrange(key, 0, -1)).map((entry) => JSON.parse(entry)),
            label,
          ).toEqual(operation.expect.stored);
        } else {
          const expected =
            scenario.coordinate === 'utf8_byte'
              ? Buffer.from(operation.expect.stored).toString('utf8')
              : operation.expect.text ?? operation.expect.stored.join('');
          expect((await client.get(key)) ?? '', label).toBe(expected);
        }
      }
    });

    it.each<Record<string, any>>(reference.persistence.joint_flushes)(
      'independent joint flush: $id',
      async (scenario: any) => {
        const jobId = id();
        const responseKey = stream.streamResponseKey(jobId);
        const stepsKey = stream.streamStepsKey(jobId);
        keys.add(responseKey);
        keys.add(stepsKey);
        for (const operation of scenario.operations) {
          const response = operation.response;
          const step = operation.steps;
          const offset =
            reference.persistence.response_boundaries[response.start].utf8_byte;
          const errors = await Promise.all([
            withFault(response.fault, () =>
              stream.appendStreamResponseDelta(
                jobId,
                response.items.join(''),
                offset,
              ),
            ),
            withFault(step.fault, () =>
              stream.appendStreamSteps(jobId, step.items, step.start),
            ),
          ]);
          for (const [index, part] of [response, step].entries()) {
            if (part.result.startsWith('error_'))
              expect(errors[index]?.message).toBe(`independent ${part.fault}`);
            else expect(errors[index]).toBeNull();
          }
          expect((await client.get(responseKey)) ?? '').toBe(
            operation.expect.response_text,
          );
          expect(
            (await client.lrange(stepsKey, 0, -1)).map((entry) =>
              JSON.parse(entry),
            ),
          ).toEqual(operation.expect.steps);
        }
      },
    );

    it.each([
      'equivalent',
      'array_order',
      'container_type',
      'concurrent_append',
      'external_replacement',
    ])('independent amendment: reordered overlap with %s', async (variant) => {
      // Literal A/B/C/X and outcomes come from the separate reviewer amendment.
      const A = { kind: 'plan', payload: [] };
      const B = {
        kind: 'tool',
        payload: { rows: [[], {}], n: 9007199254740990 },
      };
      const C = {
        kind: 'final',
        payload: { empty: {}, nested: [[[]]], n: 9007199254740991 },
      };
      const X = {
        kind: 'tool',
        payload: { rows: [[], {}], n: 9007199254740991 },
      };
      const jobId = id();
      const key = stream.streamStepsKey(jobId);
      keys.add(key);
      await client.rpush(key, JSON.stringify(A));
      if (variant !== 'concurrent_append')
        await client.rpush(key, JSON.stringify(B));
      let incoming: any[] = [
        { payload: { n: 9007199254740990, rows: [[], {}] }, kind: 'tool' },
        C,
      ];
      let offset = 1;
      if (variant === 'array_order') incoming[0].payload.rows = [{}, []];
      if (variant === 'container_type') incoming[0].payload.rows = [{}, {}];
      if (
        variant === 'concurrent_append' ||
        variant === 'external_replacement'
      ) {
        const lrange = client.lrange.bind(client);
        vi.spyOn(client, 'lrange').mockImplementationOnce(
          async (...args: any[]) => {
            const snapshot = await lrange(
              ...(args as [string, number, number]),
            );
            if (variant === 'concurrent_append')
              await client.rpush(key, JSON.stringify(X));
            else await client.lset(key, 1, JSON.stringify(X));
            return snapshot;
          },
        );
        if (variant === 'concurrent_append') {
          incoming = [{ payload: [], kind: 'plan' }, B, C];
          offset = 0;
        }
      }
      const write = () => stream.appendStreamSteps(jobId, incoming, offset);
      if (variant === 'equivalent') {
        await write();
        await write();
      } else await expect(write()).rejects.toThrow('conflict');
      const stored = (await client.lrange(key, 0, -1)).map((value) =>
        JSON.parse(value),
      );
      expect(stored).toEqual(
        variant === 'equivalent'
          ? [A, B, C]
          : variant === 'concurrent_append' ||
            variant === 'external_replacement'
          ? [A, X]
          : [A, B],
      );
    });

    const phaseFields: Record<
      string,
      | 'conversationAppliedAt'
      | 'memoryRetentionAttemptedAt'
      | 'streamStateClearedAt'
    > = {
      stored: 'conversationAppliedAt',
      delivered: 'memoryRetentionAttemptedAt',
      cleanup: 'streamStateClearedAt',
    };
    const seedJournal = async (jobId: string) => {
      await seed(jobs.finalizationJournalKey(jobId), {
        version: 1,
        state: 'pending',
        jobId,
        userId: 'alice',
        outcome: 'completed',
        finalizedAt: 1,
        finalizationId: 'f71',
        payload: reference.finalization.payload,
      });
    };
    const applyPhase = async (jobId: string, operation: any) => {
      const finalizationId = operation.finalization_id ?? 'f71';
      await jobs.markFinalizationPhase(
        jobId,
        finalizationId,
        phaseFields[operation.phase],
        operation.value.at,
      );
      if (operation.value.receipt) {
        await jobs.setMemoryRetentionReceipt(jobId, finalizationId, {
          operationId: operation.value.receipt.id,
          acceptedAt: operation.value.at,
          empty: operation.value.receipt.empty,
        } as any);
      }
    };
    const readJournal = async (jobId: string) => {
      const stored: any = await jobs.getFinalizationJournal(jobId);
      const phases: any = {};
      for (const [name, field] of Object.entries(phaseFields)) {
        if (stored[field] !== undefined) phases[name] = { at: stored[field] };
      }
      if (stored.memoryRetention)
        phases.delivered.receipt = {
          id: stored.memoryRetention.operationId,
          empty: stored.memoryRetention.empty,
        };
      return {
        finalization_id: stored.finalizationId,
        outcome: stored.outcome === 'completed' ? 'success' : 'failure',
        payload: stored.payload,
        phases,
      };
    };
    it('matches independent journal phases, first values, stale IDs, and exact JSON data', async () => {
      const jobId = id();
      await seedJournal(jobId);
      for (const operation of reference.finalization.phase_operations) {
        await applyPhase(jobId, operation);
        expect(await readJournal(jobId)).toEqual(operation.expect.stored);
      }
    });
    it.each<Record<string, any>>(reference.finalization.phase_races)(
      'retains independent concurrent phases in order $order',
      async (scenario: any) => {
        const jobId = id();
        await seedJournal(jobId);
        await Promise.all(
          scenario.operations.map((operation: any) =>
            applyPhase(jobId, operation),
          ),
        );
        expect(await readJournal(jobId)).toEqual(scenario.expect);
      },
    );
    it.each<Record<string, any>>(reference.finalization.publication_schedules)(
      'independent publication schedule: $id',
      async (scenario: any) => {
        const jobId = id();
        await seedJournal(jobId);
        const observer = client.duplicate();
        const channel = `independent:${jobId}`;
        const published: string[] = [];
        observer.on('message', (_channel, payload) => published.push(payload));
        await observer.subscribe(channel);
        try {
          for (const operation of scenario.operations) {
            const error = await withFault(operation.fault, () =>
              jobs.publishFinalizationEvents(
                jobId,
                'f71',
                [{ channel, payload: 'one completion' }],
                0,
              ),
            );
            if (operation.expect.caller === 'error')
              expect(error).toBeInstanceOf(Error);
            else expect(error).toBeNull();
            await observer.ping();
            expect(published.length).toBe(operation.expect.publications);
            const journal = await jobs.getFinalizationJournal(jobId);
            expect(journal?.eventsPublishedAt !== undefined).toBe(
              operation.expect.phase_recorded,
            );
          }
        } finally {
          observer.disconnect();
        }
      },
    );

    for (const json of [false, true]) {
      it.each<Record<string, any>>(reference.authentication.threshold_cases)(
        `session threshold $id (JSON=${json})`,
        async (row: any) => {
          cookie.sid = id();
          const key = redis.sessionKey(['auth-session', cookie.sid]);
          const initial = {
            userId: 'alice',
            username: 'alice',
            name: 'Alice',
            loginTime: 1,
            lastActivity: row.initial.activity_ms,
          };
          await seed(
            key,
            initial,
            json,
            row.initial.expires_ms - row.request_ms,
          );
          vi.spyOn(Date, 'now').mockReturnValue(row.request_ms);
          const result = await auth.getSession({} as any, {} as any);
          expect(Boolean(result)).toBe(row.expect.authorized);
          expect((await raw(key, json)).lastActivity).toBe(
            row.expect.stored.activity_ms,
          );
          const expectedTtl = row.expect.stored.expires_ms - row.request_ms;
          expect(await client.pttl(key)).toBeGreaterThan(expectedTtl - 1000);
          expect(await client.pttl(key)).toBeLessThanOrEqual(expectedTtl);
        },
      );

      it.each<Record<string, any>>(reference.authentication.schedules)(
        `session interleaving $id (JSON=${json})`,
        async (scenario: any) => {
          cookie.sid = id();
          const key = redis.sessionKey(['auth-session', cookie.sid]);
          const initial = {
            userId: 'alice',
            username: 'alice',
            name: 'Alice',
            loginTime: 1,
            lastActivity: scenario.initial.activity_ms,
          };
          await seed(key, initial, json);
          const deletion =
            scenario.id.startsWith('logout') ||
            scenario.id.startsWith('expiry');
          const lastRefresh = scenario.operations
            .filter((operation: any) => operation.op === 'refresh')
            .at(-1);
          vi.spyOn(Date, 'now').mockReturnValue(lastRefresh.request_ms);
          const get = redis.jsonGet;
          vi.spyOn(redis, 'jsonGet').mockImplementationOnce(async (readKey) => {
            const snapshot = await get(readKey);
            if (deletion) {
              if (scenario.id.startsWith('logout')) await client.del(key);
              else await client.pexpire(key, 0);
            } else {
              await seed(
                key,
                {
                  ...initial,
                  lastActivity:
                    scenario.operations[1].expect.stored.activity_ms,
                },
                json,
              );
            }
            return snapshot;
          });
          const returned = await auth.getSession({} as any, {} as any);
          const stored = await raw(key, json);
          if (deletion) {
            expect(stored).toBeNull();
            expect(returned).toBeNull();
            expect(await auth.getSession({} as any, {} as any)).toBeNull();
          } else {
            expect(stored.lastActivity).toBe(
              lastRefresh.expect.stored.activity_ms,
            );
            expect(returned?.lastActivity).toBe(
              lastRefresh.expect.stored.activity_ms,
            );
            expect(await client.pttl(key)).toBeLessThanOrEqual(120000);
          }
        },
      );

      it.each<Record<string, any>>(reference.jobs.scenarios)(
        `job $id (JSON=${json})`,
        async (scenario: any) => {
          const jobId = id();
          const key = redis.sessionKey(['async-job-status', jobId]);
          keys.add(key);
          keys.add(jobs.finalizationJournalKey(jobId));
          if (scenario.initial)
            await seed(
              key,
              {
                jobId,
                createdAt: 1,
                updatedAt: 1,
                ...encodeJob(scenario.initial),
              },
              json,
            );
          for (const operation of scenario.operations) {
            if (operation.op === 'finish') {
              const patch = encodeJob(operation.patch);
              const applied = await jobs.claimTerminalJobStatus(
                jobId,
                patch as any,
                {
                  version: 1,
                  state: 'pending',
                  jobId,
                  userId: 'alice',
                  finalizationId: operation.patch.finalization_id,
                  outcome: patch.status,
                  finalizedAt: patch.finalizedAt,
                },
              );
              expect(applied).toBe(operation.expect.result === 'applied');
            } else if (operation.op === 'callback') {
              expect(
                await jobs.completeOAuthJobRequest(jobId, operation.request_id),
              ).toBe(operation.expect.result === 'applied');
            } else {
              await jobs.updateJobStatus(jobId, encodeJob(operation.patch));
            }
            expect(decodeJob(await raw(key, json))).toEqual(
              operation.expect.stored,
            );
            const journal = await jobs.getFinalizationJournal(jobId);
            if (journal) {
              expect(decodeJob(journal.terminalStatus)).toEqual(
                operation.expect.stored,
              );
              expect(journal.finalizationId).toBe(
                operation.expect.stored.finalization_id,
              );
            }
          }
        },
      );
    }
  },
);

function encodeJob(record: any): any {
  const result: any = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'status')
      result.status =
        value === 'success'
          ? 'completed'
          : value === 'failure'
          ? 'error'
          : 'streaming';
    else if (key === 'finalized_at') result.finalizedAt = value;
    else if (key === 'finalization_id') result.finalizationId = value;
    else if (key === 'pending')
      result.oauthRequests = (value as any[]).map((request) => ({
        oauthState: request.request_id,
        authUrl: request.prompt,
      }));
    else if (key === 'visible_prompt') {
      result.oauthState = (value as any)?.request_id;
      result.authUrl = (value as any)?.prompt;
    } else result[key] = value;
  }
  return result;
}
function decodeJob(record: any): any {
  if (!record) return null;
  const result: any = {
    status:
      record.status === 'completed'
        ? 'success'
        : record.status === 'error'
        ? 'failure'
        : 'live',
    metadata: record.metadata,
    pending: (record.oauthRequests ?? []).map((request: any) => ({
      request_id: request.oauthState,
      prompt: request.authUrl,
    })),
    visible_prompt: record.oauthState
      ? { request_id: record.oauthState, prompt: record.authUrl }
      : null,
  };
  if (record.finalizedAt !== undefined)
    result.finalized_at = record.finalizedAt;
  if (record.finalizationId !== undefined)
    result.finalization_id = record.finalizationId;
  return result;
}
