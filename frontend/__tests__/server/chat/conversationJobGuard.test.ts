import {
  CONVERSATION_JOB_GUARD_TTL_SECONDS,
  CONVERSATION_JOB_INITIALIZATION_GRACE_MS,
  acquireConversationJobGuard,
  conversationJobGuardKey,
  isConversationJobInitializationStale,
  releaseConversationJobGuard,
  replaceStaleConversationJobGuard,
} from '@/server/chat/conversationJobGuard';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/session/redis', () => ({
  getRedis: vi.fn(),
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
}));

function fakeRedis() {
  const store = new Map<string, string>();
  const redis = {
    set: vi.fn(
      async (
        key: string,
        value: string,
        _expiryMode: string,
        _ttl: number,
        mode?: string,
      ) => {
        if (mode === 'NX' && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      },
    ),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    eval: vi.fn(
      async (script: string, _keys: number, key: string, ...args: any[]) => {
        if (script.includes('REPLACE_CONVERSATION_JOB_GUARD')) {
          if (store.get(key) !== args[0]) return 0;
          store.set(key, args[1]);
          return 1;
        }
        if (script.includes('RELEASE_CONVERSATION_JOB_GUARD')) {
          const raw = store.get(key);
          if (!raw) return 0;
          const current = JSON.parse(raw);
          if (
            current.version !== 1 ||
            current.userId !== args[0] ||
            current.conversationId !== args[1] ||
            current.jobId !== args[2]
          ) {
            return 0;
          }
          store.delete(key);
          return 1;
        }
        throw new Error('Unexpected Redis script');
      },
    ),
  };
  return { redis: redis as any, store };
}

describe('conversation job guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('atomically admits only one job for a user conversation', async () => {
    const { redis } = fakeRedis();

    const [first, second] = await Promise.all([
      acquireConversationJobGuard(
        'user:name',
        'conversation:1',
        'job-1',
        redis,
      ),
      acquireConversationJobGuard(
        'user:name',
        'conversation:1',
        'job-2',
        redis,
      ),
    ]);

    expect([first, second].filter((result) => result.acquired)).toHaveLength(1);
    const rejected = [first, second].find((result) => !result.acquired);
    expect(rejected).toEqual(
      expect.objectContaining({
        acquired: false,
        current: expect.objectContaining({
          userId: 'user:name',
          conversationId: 'conversation:1',
        }),
      }),
    );
    expect(redis.set).toHaveBeenCalledWith(
      conversationJobGuardKey('user:name', 'conversation:1'),
      expect.any(String),
      'EX',
      CONVERSATION_JOB_GUARD_TTL_SECONDS,
      'NX',
    );
  });

  it('releases only when user, conversation, and job ownership all match', async () => {
    const { redis, store } = fakeRedis();
    await acquireConversationJobGuard(
      'user-1',
      'conversation-1',
      'job-1',
      redis,
    );

    await expect(
      releaseConversationJobGuard(
        'user-1',
        'conversation-1',
        'job-other',
        redis,
      ),
    ).resolves.toBe(false);
    expect(store.has(conversationJobGuardKey('user-1', 'conversation-1'))).toBe(
      true,
    );

    await expect(
      releaseConversationJobGuard('user-1', 'conversation-1', 'job-1', redis),
    ).resolves.toBe(true);
    expect(store.has(conversationJobGuardKey('user-1', 'conversation-1'))).toBe(
      false,
    );
  });

  it('CAS-replaces only a missing job owner past the initialization grace', async () => {
    const { redis, store } = fakeRedis();
    const acquiredAt = 1_000;
    const initial = await acquireConversationJobGuard(
      'user-1',
      'conversation-1',
      'abandoned-job',
      redis,
      acquiredAt,
    );
    expect(initial.acquired).toBe(true);
    if (!initial.acquired) throw new Error('expected initial acquisition');
    expect(
      isConversationJobInitializationStale(
        initial.guard,
        acquiredAt + CONVERSATION_JOB_INITIALIZATION_GRACE_MS,
      ),
    ).toBe(true);

    const key = conversationJobGuardKey('user-1', 'conversation-1');
    const expectedSerialized = store.get(key)!;
    await expect(
      replaceStaleConversationJobGuard(
        'user-1',
        'conversation-1',
        `${expectedSerialized}changed`,
        'job-2',
        redis,
      ),
    ).resolves.toBeNull();

    await expect(
      replaceStaleConversationJobGuard(
        'user-1',
        'conversation-1',
        expectedSerialized,
        'job-2',
        redis,
      ),
    ).resolves.toEqual(expect.objectContaining({ jobId: 'job-2' }));
    expect(JSON.parse(store.get(key)!)).toEqual(
      expect.objectContaining({ jobId: 'job-2' }),
    );
  });

  it('fails closed when an existing guard is malformed', async () => {
    const { redis, store } = fakeRedis();
    store.set(conversationJobGuardKey('user-1', 'conversation-1'), 'not-json');

    await expect(
      acquireConversationJobGuard('user-1', 'conversation-1', 'job-2', redis),
    ).resolves.toEqual({
      acquired: false,
      current: null,
      currentSerialized: 'not-json',
    });
    expect(store.get(conversationJobGuardKey('user-1', 'conversation-1'))).toBe(
      'not-json',
    );
  });
});
