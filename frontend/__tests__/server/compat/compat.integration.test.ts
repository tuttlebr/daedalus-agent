// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const users = vi.hoisted(() => ({ list: [] as any[] }));
vi.mock('@/utils/auth/config', () => ({
  getAuthConfig: () => ({ users: users.list }),
  isConfiguredUsername: (name: string) =>
    users.list.some((user) => user.username === name),
}));
vi.mock('@/server/chat/backendSelection', () => ({
  selectStreamBackendBaseUrl: async () => 'http://127.0.0.1:1',
  getNatBaseUrl: () => 'http://127.0.0.1:1',
}));

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'compatibility API state with real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let client: ReturnType<typeof redis.getRedis>;
    const prefix = `compat-${randomUUID()}`;
    const alice = `${prefix}-alice`;
    const bob = `${prefix}-bob`;
    const jobs = new Set<string>();

    beforeAll(async () => {
      if (!process.env.REDIS_URL) throw new Error('Disposable Redis required');
      users.list = [
        { id: 'a', username: alice, name: 'Alice', passwordHash: 'x' },
        { id: 'b', username: bob, name: 'Bob', passwordHash: 'x' },
      ];
      redis = await import('@/server/session/redis');
      client = redis.getRedis();
      await client.ping();
    });

    afterAll(async () => {
      if (!client) return;
      const { STREAM_QUEUE_KEY, acknowledgeStreamQueueEntry } = await import(
        '@/server/chat/streamQueue'
      );
      for (const [entryId, fields] of await client.xrange(
        STREAM_QUEUE_KEY,
        '-',
        '+',
      )) {
        const jobId = fields[fields.indexOf('jobId') + 1];
        if (jobs.has(jobId))
          await acknowledgeStreamQueueEntry({
            entryId,
            jobId,
            reclaimed: false,
          });
      }
      const { sessionKey } = redis;
      await client.del(
        sessionKey(['user', alice, 'api-keys']),
        sessionKey(['user', bob, 'api-keys']),
      );
      for (const token of [prefix, ...jobs]) {
        let cursor = '0';
        do {
          const [next, keys] = await client.scan(
            cursor,
            'MATCH',
            `*${token}*`,
            'COUNT',
            200,
          );
          if (keys.length) await client.del(...keys);
          cursor = next;
        } while (cursor !== '0');
      }
      redis.getPublisher().disconnect();
      client.disconnect();
    });

    it('creates, verifies, rotates and revokes user-bound API keys', async () => {
      const keys = await import('@/server/apiKeys');
      const created = await keys.createApiKey(alice, ' Laptop ');
      expect(created.key).toMatch(/^dkey_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
      expect(created.metadata).toMatchObject({ name: 'Laptop' });
      // Only a verifier is stored.
      const raw = await client.get(
        redis.sessionKey(['api-key', created.metadata.id]),
      );
      expect(raw).not.toContain(created.key.split('_')[2]);

      expect(await keys.verifyApiKey(created.key)).toEqual({
        username: alice,
        userId: 'a',
        name: 'Alice',
        keyId: created.metadata.id,
      });
      const listed = await keys.listApiKeys(alice);
      expect(listed).toHaveLength(1);
      expect(listed[0].lastUsedAt).toEqual(expect.any(Number));
      expect(JSON.stringify(listed)).not.toContain(created.key);

      // A wrong secret for a real key ID fails.
      const forged = created.key.slice(0, -4) + 'AAAA';
      expect(await keys.verifyApiKey(forged)).toBeNull();
      // Another user cannot revoke or rotate it.
      await expect(
        keys.revokeApiKey(bob, created.metadata.id),
      ).rejects.toMatchObject({ reason: 'not_found' });
      await expect(
        keys.rotateApiKey(bob, created.metadata.id),
      ).rejects.toMatchObject({ reason: 'not_found' });

      const rotated = await keys.rotateApiKey(alice, created.metadata.id);
      expect(rotated.metadata.name).toBe('Laptop');
      expect(await keys.verifyApiKey(created.key)).toBeNull();
      expect((await keys.verifyApiKey(rotated.key))?.username).toBe(alice);
      expect((await keys.listApiKeys(alice)).map((k) => k.id)).toEqual([
        rotated.metadata.id,
      ]);

      await keys.revokeApiKey(alice, rotated.metadata.id);
      expect(await keys.verifyApiKey(rotated.key)).toBeNull();
      expect(await keys.listApiKeys(alice)).toEqual([]);
    });

    it('disables keys of accounts that are no longer configured and enforces the limit', async () => {
      const keys = await import('@/server/apiKeys');
      const created = await keys.createApiKey(bob, 'CI');
      users.list = users.list.filter((user) => user.username !== bob);
      expect(await keys.verifyApiKey(created.key)).toBeNull();
      users.list.push({
        id: 'b',
        username: bob,
        name: 'Bob',
        passwordHash: 'x',
      });
      expect(await keys.verifyApiKey(created.key)).not.toBeNull();

      for (let index = 1; index < keys.MAX_API_KEYS_PER_USER; index += 1) {
        await keys.createApiKey(bob, `key ${index}`);
      }
      await expect(
        keys.createApiKey(bob, 'one too many'),
      ).rejects.toMatchObject({ reason: 'limit_reached' });
      await expect(keys.createApiKey(bob, '\u0007bad')).rejects.toMatchObject({
        reason: 'invalid_name',
      });
    });

    it('binds an Idempotency-Key atomically to one request and run', async () => {
      const idempotency = await import('@/server/compat/idempotency');
      const hash = idempotency.hashCompatRequest(
        'messages',
        { a: 1, b: 2 },
        null,
      );
      // Key order does not change the request identity.
      expect(
        idempotency.hashCompatRequest('messages', { b: 2, a: 1 }, null),
      ).toBe(hash);
      expect(
        idempotency.hashCompatRequest('messages', { a: 1, b: 2 }, 'conv'),
      ).not.toBe(hash);

      const key = `${prefix}-key`;
      const claims = await Promise.all(
        ['run-1', 'run-2', 'run-3'].map((run) =>
          idempotency.claimIdempotencyKey(alice, 'messages', key, hash, run),
        ),
      );
      expect(claims.filter((claim) => claim.kind === 'claimed')).toHaveLength(
        1,
      );
      const winner = claims.findIndex((claim) => claim.kind === 'claimed');
      const runId = ['run-1', 'run-2', 'run-3'][winner];
      for (const claim of claims) {
        if (claim.kind === 'existing') expect(claim.record.jobId).toBe(runId);
      }
      expect(
        (
          await idempotency.claimIdempotencyKey(
            alice,
            'messages',
            key,
            'different',
            'run-4',
          )
        ).kind,
      ).toBe('mismatch');
      // The same key is independent for another account and route.
      expect(
        (await idempotency.claimIdempotencyKey(bob, 'messages', key, hash, 'b'))
          .kind,
      ).toBe('claimed');
      expect(
        (
          await idempotency.claimIdempotencyKey(
            alice,
            'chat.completions',
            key,
            hash,
            'c',
          )
        ).kind,
      ).toBe('claimed');

      // Only the bound run settles it, once.
      await idempotency.settleIdempotencyKey(
        alice,
        'messages',
        key,
        'run-4',
        'failed',
      );
      await idempotency.settleIdempotencyKey(
        alice,
        'messages',
        key,
        runId,
        'completed',
        {
          kind: 'completed',
          text: 'Done ✓',
          truncated: false,
        },
      );
      await idempotency.settleIdempotencyKey(
        alice,
        'messages',
        key,
        runId,
        'failed',
      );
      const replay = await idempotency.claimIdempotencyKey(
        alice,
        'messages',
        key,
        hash,
        'run-5',
      );
      expect(replay).toMatchObject({
        kind: 'existing',
        record: {
          jobId: runId,
          state: 'completed',
          outcome: { kind: 'completed', text: 'Done ✓' },
        },
      });
      const ttl = await client.ttl(
        (await client.keys(`*api-idempotency*${''}`)).find(Boolean) ?? '',
      );
      expect(ttl).toBeGreaterThan(0);

      // A rejected submission releases its binding for a clean retry.
      const released = `${prefix}-released`;
      await idempotency.claimIdempotencyKey(
        alice,
        'messages',
        released,
        hash,
        'r1',
      );
      await idempotency.releaseIdempotencyKey(
        alice,
        'messages',
        released,
        'r1',
      );
      expect(
        (
          await idempotency.claimIdempotencyKey(
            alice,
            'messages',
            released,
            hash,
            'r2',
          )
        ).kind,
      ).toBe('claimed');
    });

    it('runs isolated API jobs without a saved conversation unless approval is needed', async () => {
      const { submitChatJob } = await import('@/server/chat/submission');
      const { finalizeSuccess } = await import('@/server/chat/finalization');
      const { streamPayloadKey } = await import('@/server/chat/streamQueue');
      const { sessionKey, streamingStateKey } = redis;
      const submit = async (jobId: string) => {
        jobs.add(jobId);
        const result = await submitChatJob(
          { username: alice, userId: 'a', name: 'Alice' },
          {
            jobId,
            messages: [
              { id: randomUUID(), role: 'user', content: 'Update doc' },
            ],
            additionalProps: null,
            conversationId: null,
            conversationName: 'API: Update doc',
            storageSessionId: 'api-key-test',
            callerInstructions: 'Answer tersely.',
            responseMode: 'final_only',
            api: { protocol: 'openai', persistence: 'isolated' },
          },
        );
        expect(result).toMatchObject({ jobId, conversationId: `api-${jobId}` });
        return (await redis.jsonGet(
          sessionKey(['async-job-request', jobId]),
        )) as any;
      };

      const plainJob = `${prefix}-plain`;
      const request = await submit(plainJob);
      expect(request).toMatchObject({
        responseMode: 'final_only',
        api: { protocol: 'openai', persistence: 'isolated' },
        conversationId: `api-${plainJob}`,
      });
      const payload = (await redis.jsonGet(streamPayloadKey(plainJob))) as any;
      const contents = payload.messagesForNat.map((m: any) => m.content);
      expect(contents[0]).toMatch(/^\[IDENTITY\] .*alice/);
      expect(contents[1]).toMatch(
        /^\[CALLER_INSTRUCTIONS\][\s\S]*Answer tersely\.$/,
      );
      expect(contents[2]).toBe('Update doc');
      // Nothing visible was reserved or announced.
      expect(
        await client.exists(sessionKey(['conversation', `api-${plainJob}`])),
      ).toBe(0);
      expect(
        await client.exists(streamingStateKey(alice, `api-${plainJob}`)),
      ).toBe(0);

      const usage = {
        modelCalls: 2,
        inputTokens: 10,
        outputTokens: 3,
        cachedTokens: null,
        reportedInputTokens: 10,
        reportedOutputTokens: 3,
        reportedCachedTokens: 0,
      };
      await finalizeSuccess(plainJob, request, 'It is noon.', [], { usage });
      const status = (await redis.jsonGet(
        sessionKey(['async-job-status', plainJob]),
      )) as any;
      expect(status).toMatchObject({
        status: 'completed',
        fullResponse: 'It is noon.',
        usage,
      });
      expect(
        await client.exists(sessionKey(['conversation', `api-${plainJob}`])),
      ).toBe(0);
      expect(
        await client.exists(
          sessionKey(['memory-retention', 'submission', 'v1', plainJob]),
        ),
      ).toBe(0);
      // The user's chat slot was released by finalization.
      const { userJobGuardKey } = await import('@/server/chat/userJobGuard');
      expect(await client.zscore(userJobGuardKey(alice), plainJob)).toBeNull();

      const approvalJob = `${prefix}-approval`;
      const approvalRequest = await submit(approvalJob);
      const marker = `<!--daedalus-mcp-approval:${Buffer.from(
        JSON.stringify({
          version: 1,
          requestId: 'compat_approval_123',
          serverName: 'docs',
          toolName: 'update_doc',
          target: 'doc-1',
          summary: 'Update document doc-1',
          argumentsSha256: 'a'.repeat(64),
        }),
      ).toString('base64url')}-->`;
      await finalizeSuccess(approvalJob, approvalRequest, marker, []);
      const conversation = JSON.parse(
        (await client.get(
          sessionKey(['conversation', `api-${approvalJob}`]),
        )) as string,
      );
      expect(conversation).toMatchObject({
        id: `api-${approvalJob}`,
        ownerId: alice,
        name: 'API: Update doc',
      });
      expect(conversation.messages.map((m: any) => m.role)).toEqual([
        'user',
        'assistant',
      ]);
      expect(
        await client.sismember(
          sessionKey(['user', alice, 'conversations']),
          `api-${approvalJob}`,
        ),
      ).toBe(1);
      // Promotion for an approval is not a retained memory turn.
      expect(
        await client.exists(
          sessionKey(['memory-retention', 'submission', 'v1', approvalJob]),
        ),
      ).toBe(0);
    });
  },
);
