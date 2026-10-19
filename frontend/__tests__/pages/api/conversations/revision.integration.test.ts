// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ username: '' }));
vi.mock('@/utils/auth/session', () => ({
  getSession: async () => ({ username: session.username }),
}));
vi.mock('@/pages/api/session/imageStorage', () => ({ touchImage: vi.fn() }));

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'conversation save revisions in real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let store: typeof import('@/server/session/conversationStore');
    let handler: typeof import('@/pages/api/conversations/[id]').default;
    let client: ReturnType<typeof redis.getRedis>;
    const keys = new Set<string>();
    let serial = 0;

    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('Disposable REDIS_URL required');
      redis = await import('@/server/session/redis');
      store = await import('@/server/session/conversationStore');
      handler = (await import('@/pages/api/conversations/[id]')).default;
      client = redis.getRedis();
      await client.ping();
    });
    afterAll(async () => {
      if (client) {
        if (keys.size) await client.del(...keys);
        client.disconnect();
      }
    });

    function fixture() {
      const prefix = `revision-${process.pid}-${Date.now()}-${serial++}`;
      session.username = `${prefix}-user`;
      const id = `${prefix}-conversation`;
      keys.add(redis.sessionKey(['conversation', id]));
      keys.add(redis.sessionKey(['user', session.username, 'conversations']));
      return id;
    }

    async function call(method: string, id: string, body?: unknown) {
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        setHeader: vi.fn(),
      };
      await handler({ method, query: { id }, body } as any, res as any);
      return {
        status: res.status.mock.calls[0][0],
        body: res.json.mock.calls[0][0],
      };
    }

    it('detects a worker finalization between two browser saves', async () => {
      const id = fixture();
      // The chat request reserves the conversation; the browser's first save
      // replaces that empty reservation.
      await store.reserveConversationForUser(session.username, id, 'Chat');
      const created = await call('PUT', id, {
        id,
        name: 'Chat',
        folderId: null,
        messages: [{ id: 'u1', role: 'user', content: 'question' }],
        baseRevision: null,
      });
      expect(created.status).toBe(200);

      // Finalization writes the record without a revision, as
      // server/chat/finalization.ts applyConversationState does.
      const finalizedAt = Date.now() + 5;
      await store.saveConversationForUser(session.username, id, () => ({
        id,
        name: 'Chat',
        folderId: null,
        updatedAt: finalizedAt,
        messages: [
          { id: 'u1', role: 'user', content: 'question' },
          { id: 'a1', role: 'assistant', content: 'Finalized answer.' },
        ],
      }));

      // A save from the copy before finalization would drop the answer.
      const stale = await call('PUT', id, {
        id,
        name: 'Renamed',
        messages: [{ id: 'u1', role: 'user', content: 'question' }],
        baseRevision: created.body.revision,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.serverState.revision).toBe(`t${finalizedAt}`);

      const rebased = await call('PUT', id, {
        ...stale.body.serverState,
        name: 'Renamed',
        baseRevision: stale.body.serverState.revision,
      });
      expect(rebased.status).toBe(200);
      const read = await call('GET', id);
      expect(read.body).toMatchObject({
        name: 'Renamed',
        revision: rebased.body.revision,
        messages: [{ id: 'u1' }, { id: 'a1', content: 'Finalized answer.' }],
      });
    });
  },
);
