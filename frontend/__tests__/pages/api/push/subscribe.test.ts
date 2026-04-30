import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

const authMocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
}));

vi.mock('@/pages/api/session/redis', () => ({
  getRedis: vi.fn(() => ({})),
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  jsonDel: vi.fn(),
}));

vi.mock('@/pages/api/session/_utils', () => ({
  requireAuthenticatedUser: authMocks.requireAuthenticatedUser,
}));

// --- Import handler and mocked modules ---

import handler from '@/pages/api/push/subscribe';
import { requireAuthenticatedUser } from '@/pages/api/session/_utils';
import { jsonGet, jsonSetWithExpiry, jsonDel } from '@/pages/api/session/redis';

// --- Helpers ---

function createMockReqRes(method: string, body: any = {}) {
  const req = { method, body } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
  return { req, res };
}

// --- Tests ---

describe('push/subscribe API handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireAuthenticatedUser as any).mockResolvedValue({ username: 'user-123' });
  });

  // ----- Authentication -----

  describe('authentication', () => {
    it('returns 401 when no user ID', async () => {
      const { req, res } = createMockReqRes('POST', {
        endpoint: 'https://push.example.com/sub1',
      });
      (requireAuthenticatedUser as any).mockImplementationOnce(async () => {
        res.status(401).json({ error: 'Not authenticated' });
        return null;
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Not authenticated' });
    });
  });

  // ----- POST -----

  describe('POST', () => {
    it('stores subscription and returns 201', async () => {
      (jsonGet as any).mockResolvedValue([]);
      const subscription = {
        endpoint: 'https://push.example.com/sub1',
        keys: { p256dh: 'key1', auth: 'auth1' },
      };
      const { req, res } = createMockReqRes('POST', subscription);

      await handler(req, res);

      expect(jsonSetWithExpiry).toHaveBeenCalledWith(
        'daedalus:user:user-123:push-subscriptions',
        [subscription],
        60 * 60 * 24 * 30,
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    it('replaces existing subscription with same endpoint', async () => {
      const oldSubscription = {
        endpoint: 'https://push.example.com/sub1',
        keys: { p256dh: 'old-key', auth: 'old-auth' },
      };
      (jsonGet as any).mockResolvedValue([oldSubscription]);

      const newSubscription = {
        endpoint: 'https://push.example.com/sub1',
        keys: { p256dh: 'new-key', auth: 'new-auth' },
      };
      const { req, res } = createMockReqRes('POST', newSubscription);

      await handler(req, res);

      // Should have replaced the old subscription, not appended
      const savedData = (jsonSetWithExpiry as any).mock.calls[0][1];
      expect(savedData).toHaveLength(1);
      expect(savedData[0].keys.p256dh).toBe('new-key');
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('appends subscription for new endpoint', async () => {
      const existingSub = {
        endpoint: 'https://push.example.com/sub1',
        keys: { p256dh: 'key1', auth: 'auth1' },
      };
      (jsonGet as any).mockResolvedValue([existingSub]);

      const newSub = {
        endpoint: 'https://push.example.com/sub2',
        keys: { p256dh: 'key2', auth: 'auth2' },
      };
      const { req, res } = createMockReqRes('POST', newSub);

      await handler(req, res);

      const savedData = (jsonSetWithExpiry as any).mock.calls[0][1];
      expect(savedData).toHaveLength(2);
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('returns 400 for invalid subscription (missing endpoint)', async () => {
      const { req, res } = createMockReqRes('POST', { keys: { p256dh: 'k', auth: 'a' } });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid push subscription' });
    });

    it('returns 400 for empty body', async () => {
      const { req, res } = createMockReqRes('POST', {});

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid push subscription' });
    });

    it('returns 500 when Redis fails during POST', async () => {
      (jsonGet as any).mockRejectedValueOnce(new Error('Redis down'));
      const subscription = { endpoint: 'https://push.example.com/sub1' };
      const { req, res } = createMockReqRes('POST', subscription);

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to store subscription' });
    });
  });

  // ----- DELETE -----

  describe('DELETE', () => {
    it('removes subscription by endpoint', async () => {
      const sub1 = { endpoint: 'https://push.example.com/sub1' };
      const sub2 = { endpoint: 'https://push.example.com/sub2' };
      (jsonGet as any).mockResolvedValue([sub1, sub2]);

      const { req, res } = createMockReqRes('DELETE', {
        endpoint: 'https://push.example.com/sub1',
      });

      await handler(req, res);

      // Should save remaining subscription
      expect(jsonSetWithExpiry).toHaveBeenCalledWith(
        'daedalus:user:user-123:push-subscriptions',
        [sub2],
        60 * 60 * 24 * 30,
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    it('deletes key when last subscription is removed', async () => {
      const sub = { endpoint: 'https://push.example.com/sub1' };
      (jsonGet as any).mockResolvedValue([sub]);

      const { req, res } = createMockReqRes('DELETE', {
        endpoint: 'https://push.example.com/sub1',
      });

      await handler(req, res);

      // When no subscriptions remain, should delete the key entirely
      expect(jsonDel).toHaveBeenCalledWith('daedalus:user:user-123:push-subscriptions');
      expect(jsonSetWithExpiry).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 400 when endpoint is missing from body', async () => {
      const { req, res } = createMockReqRes('DELETE', {});

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Missing endpoint' });
    });

    it('returns 500 when Redis fails during DELETE', async () => {
      (jsonGet as any).mockRejectedValueOnce(new Error('Redis down'));
      const { req, res } = createMockReqRes('DELETE', {
        endpoint: 'https://push.example.com/sub1',
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to remove subscription' });
    });
  });

  // ----- Unsupported Methods -----

  describe('unsupported methods', () => {
    it('returns 405 for GET', async () => {
      const { req, res } = createMockReqRes('GET');

      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST', 'DELETE']);
      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.end).toHaveBeenCalledWith('Method Not Allowed');
    });

    it('returns 405 for PUT', async () => {
      const { req, res } = createMockReqRes('PUT');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(405);
    });

    it('returns 405 for PATCH', async () => {
      const { req, res } = createMockReqRes('PATCH');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(405);
    });
  });
});
