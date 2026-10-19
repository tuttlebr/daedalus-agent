import { getSession } from '@/utils/auth/session';
import { publishSyncEvent } from '@/utils/sync/publish';

// --- Import handler and mocked modules ---
import handler from '@/pages/api/conversations/[id]';

import { deleteConversationForUser } from '@/server/session/conversationDeletion';
import { jsonGet, jsonSet } from '@/server/session/redis';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

// --- Mocks ---

const mockSismember = vi.fn().mockResolvedValue(1);
const mockSadd = vi.fn().mockResolvedValue(1);

vi.mock('@/server/session/redis', () => ({
  getRedis: vi.fn(() => ({
    sismember: mockSismember,
    eval: async (script: string, _count: number, ...args: any[]) => {
      if (script.includes('READ_OWNED_CONVERSATION')) {
        const value = await jsonGet(args[0]);
        return [
          value ? JSON.stringify(value) : '',
          await mockSismember(args[1], args[2]),
        ];
      }
      if (script.includes('SAVE_OWNED_CONVERSATION')) {
        await jsonSet(args[0], '$', JSON.parse(args[3]));
        await mockSadd(args[1], args[4]);
        return 1;
      }
      throw new Error('Unexpected Redis script in route fixture');
    },
    sadd: mockSadd,
  })),
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
  jsonGet: vi.fn(),
  jsonSet: vi.fn(),
}));

vi.mock('@/server/session/conversationDeletion', () => ({
  deleteConversationForUser: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/utils/auth/session', () => ({
  getSession: vi.fn().mockResolvedValue({ username: 'testuser' }),
}));

vi.mock('@/utils/sync/publish', () => ({
  publishSyncEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/pages/api/session/imageStorage', () => ({
  touchImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/utils/app/imageHandler', () => ({
  extractImageReferences: vi.fn().mockReturnValue([]),
}));

// --- Helpers ---

function createMockReqRes(method: string, query: any = {}, body: any = {}) {
  const req = { method, query, body } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
  return { req, res };
}

// --- Tests ---

describe('conversations/[id] API handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock behavior
    (getSession as any).mockResolvedValue({ username: 'testuser' });
    mockSismember.mockResolvedValue(1);
    vi.mocked(deleteConversationForUser).mockResolvedValue(true);
  });

  // ----- Authentication & Validation -----

  describe('authentication and validation', () => {
    it('returns 401 when no session', async () => {
      (getSession as any).mockResolvedValue(null);
      const { req, res } = createMockReqRes('GET', { id: 'conv-1' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Not authenticated' });
    });

    it('returns 400 for missing conversation ID', async () => {
      const { req, res } = createMockReqRes('GET', {});

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid conversation ID',
      });
    });

    it('returns 400 for non-string conversation ID (array)', async () => {
      const { req, res } = createMockReqRes('GET', { id: ['a', 'b'] });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid conversation ID',
      });
    });

    it('returns 405 for unsupported methods', async () => {
      const { req, res } = createMockReqRes('PATCH', { id: 'conv-1' });

      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Allow', [
        'GET',
        'PUT',
        'DELETE',
      ]);
      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.json).toHaveBeenCalledWith({ error: 'Method not allowed' });
    });
  });

  // ----- GET -----

  describe('GET', () => {
    it('returns conversation data when found', async () => {
      const conversationData = {
        id: 'conv-1',
        name: 'Test Conversation',
        messages: [],
        updatedAt: 1000,
      };
      (jsonGet as any).mockResolvedValue(conversationData);
      const { req, res } = createMockReqRes('GET', { id: 'conv-1' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      // A record without a stored revision is identified by its server
      // timestamp.
      expect(res.json).toHaveBeenCalledWith({
        ...conversationData,
        revision: 't1000',
      });
    });

    it('preserves legitimate repeated assistant text on read', async () => {
      const prior = 'Daily summary for May 13, 2026.';
      const next = 'The namespace is healthy.';
      const conversationData = {
        id: 'conv-1',
        name: 'Test Conversation',
        messages: [
          { role: 'user', content: 'daily summary' },
          { role: 'assistant', content: prior },
          { role: 'user', content: 'namespace?' },
          { role: 'assistant', content: `${prior}\n\n${next}` },
        ],
        updatedAt: 1000,
      };
      (jsonGet as any).mockResolvedValue(conversationData);
      const { req, res } = createMockReqRes('GET', { id: 'conv-1' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        ...conversationData,
        revision: 't1000',
      });
      expect(jsonSet).not.toHaveBeenCalled();
    });

    it('returns 404 when conversation not found', async () => {
      // No conversation data and no job data
      (jsonGet as any).mockResolvedValue(null);
      const { req, res } = createMockReqRes('GET', { id: 'conv-1' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Conversation not found',
      });
    });

    it('does not serve an unowned conversation-job record for a missing conversation', async () => {
      // Nothing writes conversation-job:<id>; any such record is unowned and
      // must not stand in for the user's missing conversation.
      (jsonGet as any).mockImplementation(async (key: string) =>
        key === 'daedalus:conversation-job:conv-1'
          ? { messages: [{ role: 'assistant', content: 'private' }] }
          : null,
      );
      const { req, res } = createMockReqRes('GET', { id: 'conv-1' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Conversation not found',
      });
    });

    it('returns 403 for unowned conversation', async () => {
      mockSismember.mockResolvedValue(0);
      const { req, res } = createMockReqRes('GET', { id: 'conv-1' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Forbidden: You do not have access to this conversation',
      });
    });
  });

  // ----- PUT -----

  describe('PUT', () => {
    it('saves conversation and returns success', async () => {
      // No existing data (new conversation)
      (jsonGet as any).mockResolvedValue(null);
      const body = { id: 'conv-1', name: 'New Conversation', messages: [] };
      const { req, res } = createMockReqRes('PUT', { id: 'conv-1' }, body);

      await handler(req, res);

      expect(jsonSet).toHaveBeenCalled();
      expect(mockSadd).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      const saved = (jsonSet as any).mock.calls[0][2];
      // The committed concurrency token comes back for the next save.
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        revision: saved.revision,
        updatedAt: saved.updatedAt,
      });
      expect(saved.revision).toEqual(expect.any(String));
    });

    it('merges with existing data on update', async () => {
      const existingData = {
        id: 'conv-1',
        name: 'Old Name',
        messages: [],
        updatedAt: 1000,
      };
      // First jsonGet returns existing data, subsequent calls return [] for history
      (jsonGet as any)
        .mockResolvedValueOnce(existingData)
        .mockResolvedValue([]);

      const body = {
        id: 'conv-1',
        name: 'Updated Name',
        updatedAt: 2000,
      };
      const { req, res } = createMockReqRes('PUT', { id: 'conv-1' }, body);

      await handler(req, res);

      expect(jsonSet).toHaveBeenCalled();
      // Verify the saved data merges existing + updated fields
      const savedData = (jsonSet as any).mock.calls[0][2];
      expect(savedData.name).toBe('Updated Name');
      expect(savedData.messages).toEqual([]);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 409 on conflict (server has newer data)', async () => {
      const existingData = {
        id: 'conv-1',
        name: 'Server Version',
        updatedAt: 5000,
      };
      (jsonGet as any).mockResolvedValueOnce(existingData);

      const body = {
        id: 'conv-1',
        name: 'Client Version',
        updatedAt: 3000, // Client's data is older
      };
      const { req, res } = createMockReqRes('PUT', { id: 'conv-1' }, body);

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Conflict: server has newer data',
        serverState: { ...existingData, revision: 't5000' },
      });
    });

    describe('server-issued revisions', () => {
      const stored = {
        id: 'conv-1',
        name: 'Chat',
        updatedAt: 5000,
        revision: 'rev-current',
        messages: [
          { id: 'u1', role: 'user', content: 'question' },
          { id: 'a1', role: 'assistant', content: 'Finalized answer.' },
        ],
      };

      it('rejects a stale base even when its clock reads later', async () => {
        (jsonGet as any).mockResolvedValue(stored);
        // This device last saw an older revision; its clock is ahead of the
        // server. Accepting it would drop the finalized answer.
        const body = {
          id: 'conv-1',
          baseRevision: 'rev-older',
          updatedAt: 9_999_999_999_999,
          messages: [{ id: 'u1', role: 'user', content: 'question' }],
        };
        const { req, res } = createMockReqRes('PUT', { id: 'conv-1' }, body);

        await handler(req, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ serverState: stored }),
        );
        expect(jsonSet).not.toHaveBeenCalled();
      });

      it('accepts the current base from a client whose clock is behind', async () => {
        (jsonGet as any).mockResolvedValue(stored);
        const now = 1_700_000_000_000;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        onTestFinished(() => clock.mockRestore());
        const body = {
          id: 'conv-1',
          name: 'Renamed',
          baseRevision: 'rev-current',
          updatedAt: 1, // a clock far behind the server's
          messages: stored.messages,
        };
        const { req, res } = createMockReqRes('PUT', { id: 'conv-1' }, body);

        await handler(req, res);

        const saved = (jsonSet as any).mock.calls[0][2];
        expect(res.status).toHaveBeenCalledWith(200);
        expect(saved).toMatchObject({ name: 'Renamed', updatedAt: now });
        expect(saved).not.toHaveProperty('baseRevision');
        expect(saved.revision).not.toBe('rev-current');
        expect(res.json).toHaveBeenCalledWith({
          success: true,
          revision: saved.revision,
          updatedAt: now,
        });
      });

      it('identifies records written without a revision by their timestamp', async () => {
        // Worker finalization and older saves store no revision.
        const { revision: _omit, ...finalized } = stored;
        (jsonGet as any).mockResolvedValue(finalized);
        const accepted = createMockReqRes(
          'PUT',
          { id: 'conv-1' },
          { id: 'conv-1', name: 'Renamed', baseRevision: 't5000' },
        );
        await handler(accepted.req, accepted.res);
        expect(accepted.res.status).toHaveBeenCalledWith(200);

        vi.mocked(jsonSet).mockClear();
        const stale = createMockReqRes(
          'PUT',
          { id: 'conv-1' },
          { id: 'conv-1', name: 'Renamed', baseRevision: 't4000' },
        );
        await handler(stale.req, stale.res);
        expect(stale.res.status).toHaveBeenCalledWith(409);
        expect(jsonSet).not.toHaveBeenCalled();
      });

      it('lets a first save replace the reservation its chat request made', async () => {
        const reservation = {
          id: 'conv-1',
          ownerId: 'testuser',
          name: 'New conversation',
          folderId: null,
          messages: [],
          updatedAt: 0,
        };
        (jsonGet as any).mockResolvedValue(reservation);
        const first = createMockReqRes(
          'PUT',
          { id: 'conv-1' },
          {
            id: 'conv-1',
            name: 'Hello',
            messages: [{ id: 'u1', role: 'user', content: 'Hello' }],
            baseRevision: null,
          },
        );
        await handler(first.req, first.res);
        expect(first.res.status).toHaveBeenCalledWith(200);

        // A record anyone has saved since is not overwritten by a null base.
        vi.mocked(jsonSet).mockClear();
        (jsonGet as any).mockResolvedValue({ ...reservation, updatedAt: 42 });
        const stale = createMockReqRes(
          'PUT',
          { id: 'conv-1' },
          { id: 'conv-1', messages: [], baseRevision: null },
        );
        await handler(stale.req, stale.res);
        expect(stale.res.status).toHaveBeenCalledWith(409);
        expect(jsonSet).not.toHaveBeenCalled();
      });

      it('creates a missing record and rejects a malformed base', async () => {
        (jsonGet as any).mockResolvedValue(null);
        const created = createMockReqRes(
          'PUT',
          { id: 'conv-1' },
          { id: 'conv-1', name: 'New', messages: [], baseRevision: null },
        );
        await handler(created.req, created.res);
        expect(created.res.status).toHaveBeenCalledWith(200);

        const malformed = createMockReqRes(
          'PUT',
          { id: 'conv-1' },
          { id: 'conv-1', baseRevision: 42 },
        );
        await handler(malformed.req, malformed.res);
        expect(malformed.res.status).toHaveBeenCalledWith(400);
      });
    });

    it('sets server-authoritative updatedAt timestamp', async () => {
      (jsonGet as any).mockResolvedValue(null);
      const now = 1700000000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const body = { id: 'conv-1', updatedAt: 1600000000000 };
      const { req, res } = createMockReqRes('PUT', { id: 'conv-1' }, body);

      await handler(req, res);

      const savedData = (jsonSet as any).mock.calls[0][2];
      expect(savedData.updatedAt).toBe(now);

      vi.spyOn(Date, 'now').mockRestore();
    });

    it('returns 403 when updating an unowned existing conversation', async () => {
      const existingData = {
        id: 'conv-1',
        name: 'Someone Else Conversation',
        updatedAt: 1000,
      };
      (jsonGet as any).mockResolvedValueOnce(existingData);
      mockSismember.mockResolvedValue(0);

      const body = { id: 'conv-1', name: 'Hijack', updatedAt: 2000 };
      const { req, res } = createMockReqRes('PUT', { id: 'conv-1' }, body);

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Forbidden: You do not have access to this conversation',
      });
    });

    it.each([null, ['message'], 'conversation'])(
      'rejects a non-object conversation body without writing: %j',
      async (body) => {
        (jsonGet as any).mockResolvedValue({ id: 'conv-1', updatedAt: 1 });
        const { req, res } = createMockReqRes('PUT', { id: 'conv-1' }, body);

        await handler(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(jsonSet).not.toHaveBeenCalled();
      },
    );

    it('returns 500 when jsonSet throws', async () => {
      (jsonGet as any).mockResolvedValue(null);
      (jsonSet as any).mockRejectedValueOnce(new Error('Redis down'));

      const body = { id: 'conv-1' };
      const { req, res } = createMockReqRes('PUT', { id: 'conv-1' }, body);

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Failed to save conversation',
      });
    });
  });

  // ----- DELETE -----

  describe('DELETE', () => {
    it('deletes using the authenticated user and requested conversation', async () => {
      const { req, res } = createMockReqRes('DELETE', { id: 'conv-1' });

      await handler(req, res);

      expect(deleteConversationForUser).toHaveBeenCalledWith(
        'testuser',
        'conv-1',
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true });
      // Other sessions remove it as well.
      expect(publishSyncEvent).toHaveBeenCalledWith('testuser', {
        type: 'conversation_deleted',
        timestamp: expect.any(Number),
        data: { conversationId: 'conv-1' },
      });
    });

    it('returns 403 when deleting unowned conversation', async () => {
      vi.mocked(deleteConversationForUser).mockResolvedValue(false);
      const { req, res } = createMockReqRes('DELETE', { id: 'conv-1' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Forbidden: You do not have access to this conversation',
      });
      expect(jsonSet).not.toHaveBeenCalled();
    });

    it('returns 500 when durable deletion fails', async () => {
      vi.mocked(deleteConversationForUser).mockRejectedValueOnce(
        new Error('Redis down'),
      );
      const { req, res } = createMockReqRes('DELETE', { id: 'conv-1' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Failed to delete conversation',
      });
    });
  });
});
