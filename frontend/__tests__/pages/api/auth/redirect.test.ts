import type { NextApiRequest, NextApiResponse } from 'next';

import { fetchWithTimeout } from '@/utils/fetchWithTimeout';

import handler from '@/pages/api/auth/redirect';

import {
  deleteOAuthCallbackTarget,
  loadOAuthCallbackTarget,
} from '@/server/mcpOAuth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/mcpOAuth', () => ({
  deleteOAuthCallbackTarget: vi.fn(),
  loadOAuthCallbackTarget: vi.fn(),
}));

vi.mock('@/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}));

function createMockReqRes(method: string, query: NextApiRequest['query'] = {}) {
  const req = {
    method,
    query,
    headers: {
      host: 'daedalus.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '198.51.100.8',
    },
  } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as unknown as NextApiResponse & {
    status: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
  };
  return { req, res };
}

describe('MCP OAuth redirect API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies the callback to the exact backend pod and consumes the route', async () => {
    vi.mocked(loadOAuthCallbackTarget).mockResolvedValue({
      backendBaseUrl: 'http://10.1.2.3:8000',
      createdAt: Date.now(),
    });
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      new Response('<html>connected</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    const { req, res } = createMockReqRes('GET', {
      code: 'google-code',
      state: 'oauth-state',
      scope: ['gmail.readonly', 'openid'],
    });

    await handler(req, res);

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      'http://10.1.2.3:8000/auth/redirect?code=google-code&state=oauth-state&scope=gmail.readonly&scope=openid',
      {
        method: 'GET',
        headers: {
          Host: 'daedalus.example.test',
          'X-Forwarded-For': '198.51.100.8',
          'X-Forwarded-Host': 'daedalus.example.test',
          'X-Forwarded-Proto': 'https',
        },
      },
      60000,
    );
    expect(deleteOAuthCallbackTarget).toHaveBeenCalledWith('oauth-state');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('<html>connected</html>');
  });

  it('rejects missing or expired state without contacting a backend', async () => {
    vi.mocked(loadOAuthCallbackTarget).mockResolvedValue(null);
    const missing = createMockReqRes('GET');
    const expired = createMockReqRes('GET', { state: 'expired-state' });

    await handler(missing.req, missing.res);
    await handler(expired.req, expired.res);

    expect(missing.res.status).toHaveBeenCalledWith(400);
    expect(expired.res.status).toHaveBeenCalledWith(400);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('retains the target after a transient backend network failure', async () => {
    vi.mocked(loadOAuthCallbackTarget).mockResolvedValue({
      backendBaseUrl: 'http://10.1.2.3:8000',
      createdAt: Date.now(),
    });
    vi.mocked(fetchWithTimeout).mockRejectedValue(
      new Error('connection reset'),
    );
    const { req, res } = createMockReqRes('GET', { state: 'oauth-state' });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(deleteOAuthCallbackTarget).not.toHaveBeenCalled();
  });
});
