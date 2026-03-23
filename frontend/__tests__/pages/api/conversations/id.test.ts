import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// --- Mocks ---

const mockSismember = vi.fn().mockResolvedValue(1);
const mockSadd = vi.fn().mockResolvedValue(1);
const mockSrem = vi.fn().mockResolvedValue(1);

vi.mock('@/pages/api/session/redis', () => ({
  getRedis: vi.fn(() => ({
    sismember: mockSismember,
    sadd: mockSadd,
    srem: mockSrem,
  })),
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  jsonDel: vi.fn(),
}));

vi.mock('@/utils/auth/session', () => ({
  getSession: vi.fn().mockResolvedValue({ username: 'testuser' }),
}));

vi.mock('@/pages/api/session/_utils', () => ({
  getUserId: vi.fn().mockResolvedValue('testuser'),
}));

vi.mock('@/pages/api/session/imageStorage', () => ({
  touchImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/utils/app/imageHandler', () => ({
  extractImageReferences: vi.fn().mockReturnValue([]),
}));

vi.mock('@/pages/api/session/sanitize', () => ({
  clampConversations: vi.fn((arr: any[]) => arr),
}));

// --- Import handler and mocked modules ---

import handler from '@/pages/api/conversations/[id]';
import { getSession } from '@/utils/auth/session';
import { jsonGet, jsonSetWithExpiry, jsonDel } from '@/pages/api/session/redis';

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
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid conversation ID' });
    });

    it('returns 400 for non-string conversation ID (array)', async () => {
      const { req, res } = createMockReqRes('GET', { id: ['a', 'b'] });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid conversation ID' });
    });

    it('returns 405 for unsupported methods', async () => {
      const { req, res } = createMockReqRes('PATCH', { id: 'conv-1' });

      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'PUT', 'DELETE']);
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
      expect(res.json).toHaveBeenCalledWith(conversationData);
    });

    it('returns 404 when conversation not found', async () => {
      // No conversation data and no job data
      (jsonGet as any).mockResolvedValue(null);
      const { req, res } = createMockReqRes('GET', { id: 'conv-1' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Conversation not found' });
    });

    it('returns job data when conversation not found but job exists', async () => {
      const jobData = {
        messages: [{ role: 'assistant', content: 'Hello' }],
        status: 'completed',
      };
      // First call (conversation key) returns null, second call (job key) returns jobData
      (jsonGet as any)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(jobData);
      const { req, res } = createMockReqRes('GET', { id: 'conv-1' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        messages: jobData.messages,
        status: 'completed',
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

      expect(jsonSetWithExpiry).toHaveBeenCalled();
      expect(mockSadd).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true });
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

      expect(jsonSetWithExpiry).toHaveBeenCalled();
      // Verify the saved data merges existing + updated fields
      const savedData = (jsonSetWithExpiry as any).mock.calls[0][1];
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
        serverState: existingData,
      });
    });

    it('sets server-authoritative updatedAt timestamp', async () => {
      (jsonGet as any).mockResolvedValue(null);
      const now = 1700000000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const body = { id: 'conv-1', updatedAt: 1600000000000 };
      const { req, res } = createMockReqRes('PUT', { id: 'conv-1' }, body);

      await handler(req, res);

      const savedData = (jsonSetWithExpiry as any).mock.calls[0][1];
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

    it('returns 500 when jsonSetWithExpiry throws', async () => {
      (jsonGet as any).mockResolvedValue(null);
      (jsonSetWithExpiry as any).mockRejectedValueOnce(new Error('Redis down'));

      const body = { id: 'conv-1' };
      const { req, res } = createMockReqRes('PUT', { id: 'conv-1' }, body);

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to save conversation' });
    });
  });

  // ----- DELETE -----

  describe('DELETE', () => {
    it('removes conversation and from user set', async () => {
      (jsonGet as any).mockResolvedValue([]);
      const { req, res } = createMockReqRes('DELETE', { id: 'conv-1' });

      await handler(req, res);

      expect(jsonDel).toHaveBeenCalledWith('daedalus:conversation:conv-1');
      expect(mockSrem).toHaveBeenCalledWith(
        'daedalus:user:testuser:conversations',
        'conv-1',
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    it('returns 403 when deleting unowned conversation', async () => {
      mockSismember.mockResolvedValue(0);
      const { req, res } = createMockReqRes('DELETE', { id: 'conv-1' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Forbidden: You do not have access to this conversation',
      });
      expect(jsonDel).not.toHaveBeenCalled();
    });

    it('returns 500 when jsonDel throws', async () => {
      (jsonDel as any).mockRejectedValueOnce(new Error('Redis down'));
      const { req, res } = createMockReqRes('DELETE', { id: 'conv-1' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to delete conversation' });
    });
  });
});
