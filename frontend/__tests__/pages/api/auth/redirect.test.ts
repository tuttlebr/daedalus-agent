import type { NextApiRequest, NextApiResponse } from 'next';

import { getSession } from '@/utils/auth/session';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout';

import handler from '@/pages/api/auth/redirect';

import { completeOAuthJobRequest } from '@/server/chat/jobState';
import {
  loadOAuthCallbackTarget,
  saveOAuthCallbackTarget,
} from '@/server/mcpOAuth';
import { jsonDel } from '@/server/session/redis';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, unknown>());

// The real callback-target and ownership code runs against this keyspace.
vi.mock('@/server/session/redis', () => ({
  jsonDel: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  jsonGet: vi.fn(async (key: string) => store.get(key) ?? null),
  jsonSetWithExpiry: vi.fn(async (key: string, value: unknown) => {
    store.set(key, value);
  }),
  sessionKey: (parts: string[]) => parts.join(':'),
}));

vi.mock('@/utils/auth/session', () => ({ getSession: vi.fn() }));

vi.mock('@/server/chat/jobState', () => ({
  completeOAuthJobRequest: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}));

const BACKEND = 'http://10.1.2.3:8000';

function createMockReqRes(
  method: string,
  input: Record<string, string | string[]> = {},
) {
  const req = {
    method,
    query: method === 'GET' ? input : {},
    body: method === 'POST' ? input : undefined,
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

function signedIn(username: string | null) {
  vi.mocked(getSession).mockResolvedValue(
    username
      ? ({
          userId: '1',
          username,
          name: username,
          loginTime: 1,
          lastActivity: 1,
        } as any)
      : null,
  );
}

function header(res: { setHeader: ReturnType<typeof vi.fn> }, name: string) {
  return res.setHeader.mock.calls.find(([key]) => key === name)?.[1];
}

describe('MCP OAuth redirect API', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    store.clear();
    signedIn('alice');
    await saveOAuthCallbackTarget('oauth-state', BACKEND, 'job-123', 'alice');
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      new Response('<html>connected</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
  });

  it('renders a same-origin continuation page for the cross-site callback without forwarding it', async () => {
    const { req, res } = createMockReqRes('GET', {
      code: 'google-code',
      state: 'oauth-state',
      scope: ['gmail.readonly', 'openid'],
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const page = res.send.mock.calls[0][0] as string;
    expect(page).toContain(
      '<form id="oauth-callback" method="post" action="/api/auth/redirect">',
    );
    expect(page).toContain(
      '<input type="hidden" name="state" value="oauth-state">',
    );
    expect(page).toContain(
      '<input type="hidden" name="code" value="google-code">',
    );
    expect(page).toContain('<button type="submit">Continue</button>');
    // The page's own CSP must allow exactly its auto-submit script.
    const script = /<script>([^<]*)<\/script>/.exec(page)![1];
    const policy = header(res, 'Content-Security-Policy') as string;
    expect(policy).toContain(
      `script-src 'sha256-${createHash('sha256')
        .update(script)
        .digest('base64')}'`,
    );
    expect(policy).toContain("form-action 'self'");
    expect(header(res, 'Referrer-Policy')).toBe('no-referrer');
    expect(header(res, 'Cache-Control')).toBe('no-cache, no-store');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(completeOAuthJobRequest).not.toHaveBeenCalled();
    await expect(
      loadOAuthCallbackTarget('oauth-state'),
    ).resolves.not.toBeNull();
  });

  it('escapes callback values rendered into the continuation page', async () => {
    const { req, res } = createMockReqRes('GET', {
      state: 'oauth-state',
      code: '"><script>alert(1)</script>',
    });

    await handler(req, res);

    const page = res.send.mock.calls[0][0] as string;
    expect(page).not.toContain('<script>alert(1)');
    expect(page).toContain(
      'value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"',
    );
  });

  it('rejects an unauthenticated continuation without contacting a backend', async () => {
    signedIn(null);
    const { req, res } = createMockReqRes('POST', {
      code: 'google-code',
      state: 'oauth-state',
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(completeOAuthJobRequest).not.toHaveBeenCalled();
    await expect(
      loadOAuthCallbackTarget('oauth-state'),
    ).resolves.not.toBeNull();
  });

  it("refuses another user's consent for the initiator's flow", async () => {
    // Bob forwarded his genuine consent URL to Alice; her session must not
    // complete it, or her Google grant would be stored under Bob.
    await saveOAuthCallbackTarget('bob-state', BACKEND, 'job-bob', 'bob');
    const { req, res } = createMockReqRes('POST', {
      code: 'alice-google-code',
      state: 'bob-state',
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(completeOAuthJobRequest).not.toHaveBeenCalled();
    // Bob can still finish his own authorization.
    await expect(loadOAuthCallbackTarget('bob-state')).resolves.toMatchObject({
      userId: 'bob',
    });
  });

  it('binds targets from older stream workers to the owner of their chat job', async () => {
    await saveOAuthCallbackTarget('legacy-state', BACKEND, 'job-legacy');
    store.set('async-job-request:job-legacy', { userId: 'bob' });
    const foreign = createMockReqRes('POST', {
      code: 'google-code',
      state: 'legacy-state',
    });

    await handler(foreign.req, foreign.res);

    expect(foreign.res.status).toHaveBeenCalledWith(403);
    expect(fetchWithTimeout).not.toHaveBeenCalled();

    signedIn('bob');
    const owner = createMockReqRes('POST', {
      code: 'google-code',
      state: 'legacy-state',
    });
    await handler(owner.req, owner.res);

    expect(owner.res.status).toHaveBeenCalledWith(200);
    expect(fetchWithTimeout).toHaveBeenCalledOnce();
  });

  it("forwards the owner's callback to the exact backend pod and consumes the route", async () => {
    const { req, res } = createMockReqRes('POST', {
      code: 'google-code',
      state: 'oauth-state',
    });

    await handler(req, res);

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      'http://10.1.2.3:8000/auth/redirect?state=oauth-state&code=google-code',
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
    await expect(loadOAuthCallbackTarget('oauth-state')).resolves.toBeNull();
    expect(completeOAuthJobRequest).toHaveBeenCalledWith(
      'job-123',
      'oauth-state',
    );
    expect(header(res, 'Content-Type')).toBe('text/html; charset=utf-8');
    expect(header(res, 'Content-Disposition')).toBe('inline');
    // The callback page reflects a one-time authorization exchange.
    expect(header(res, 'Cache-Control')).toBe('no-cache, no-store');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('<html>connected</html>');
  });

  it('renders the callback inline when the backend omits a content type', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '<html>connected</html>',
    } as Response);
    const { req, res } = createMockReqRes('POST', {
      code: 'google-code',
      state: 'oauth-state',
    });

    await handler(req, res);

    expect(header(res, 'Content-Type')).toBe('text/html; charset=utf-8');
    expect(header(res, 'Content-Disposition')).toBe('inline');
  });

  it('preserves completed authorization when routing-key cleanup fails', async () => {
    vi.mocked(jsonDel).mockRejectedValueOnce(new Error('Redis unavailable'));
    const { req, res } = createMockReqRes('POST', {
      code: 'google-code',
      state: 'oauth-state',
    });

    await handler(req, res);

    expect(fetchWithTimeout).toHaveBeenCalledOnce();
    expect(completeOAuthJobRequest).toHaveBeenCalledWith(
      'job-123',
      'oauth-state',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('<html>connected</html>');
  });

  it.each(['GET', 'POST'])(
    'rejects missing or expired state without contacting a backend (%s)',
    async (method) => {
      const missing = createMockReqRes(method);
      const expired = createMockReqRes(method, { state: 'expired-state' });

      await handler(missing.req, missing.res);
      await handler(expired.req, expired.res);

      expect(missing.res.status).toHaveBeenCalledWith(400);
      expect(expired.res.status).toHaveBeenCalledWith(400);
      for (const response of [missing.res, expired.res]) {
        expect(header(response, 'Content-Type')).toBe(
          'text/html; charset=utf-8',
        );
        expect(header(response, 'Content-Disposition')).toBe('inline');
        expect(header(response, 'Cache-Control')).toBe('no-cache, no-store');
      }
      expect(fetchWithTimeout).not.toHaveBeenCalled();
    },
  );

  it('rejects other methods', async () => {
    const { req, res } = createMockReqRes('PUT');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'POST']);
  });

  it('retains the target after a transient backend network failure', async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValue(
      new Error('connection reset'),
    );
    const { req, res } = createMockReqRes('POST', { state: 'oauth-state' });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(header(res, 'Content-Type')).toBe('text/html; charset=utf-8');
    expect(header(res, 'Content-Disposition')).toBe('inline');
    await expect(
      loadOAuthCallbackTarget('oauth-state'),
    ).resolves.not.toBeNull();
    expect(completeOAuthJobRequest).not.toHaveBeenCalled();
  });

  it('does not report OAuth completion for a rejected backend callback', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      new Response('authorization denied', { status: 400 }),
    );
    const { req, res } = createMockReqRes('POST', {
      state: 'oauth-state',
      error: 'access_denied',
    });

    await handler(req, res);

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      'http://10.1.2.3:8000/auth/redirect?state=oauth-state&error=access_denied',
      expect.any(Object),
      60000,
    );
    expect(completeOAuthJobRequest).not.toHaveBeenCalled();
    await expect(loadOAuthCallbackTarget('oauth-state')).resolves.toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
