import { fetchWithTimeout } from '@/utils/fetchWithTimeout';

import handler, { resolveMemoryRoute } from '@/pages/api/memory/[...path]';

import { requireAuthenticatedUser } from '@/server/session/_utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: vi.fn(),
}));

vi.mock('@/utils/app/backendApi', () => ({
  buildBackendBaseUrlForMode: vi.fn(() => 'http://backend:8000'),
  buildBackendUrlFromBase: vi.fn(
    (baseUrl: string, path: string) => `${baseUrl}${path}`,
  ),
}));

vi.mock('@/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}));

function call(
  method: string,
  path: string[],
  query: Record<string, string | string[]> = {},
  body?: unknown,
) {
  const req = {
    method,
    query: { ...query, path },
    body,
    headers: { 'x-user-id': 'mallory', cookie: 'nat-session=mallory' },
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
  return { req, res };
}

describe('Memory Center proxy handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DAEDALUS_INTERNAL_API_TOKEN', 'internal-secret');
    vi.mocked(requireAuthenticatedUser).mockResolvedValue({
      username: 'alice',
    } as Awaited<ReturnType<typeof requireAuthenticatedUser>>);
    vi.mocked(fetchWithTimeout).mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('injects only the authenticated identity and forwards list filters', async () => {
    const { req, res } = call('GET', ['memories'], {
      limit: '5',
      q: ['alpha', 'beta'],
    });

    await handler(req, res);

    const [url, init] = vi.mocked(fetchWithTimeout).mock.calls[0];
    expect(url).toBe('http://backend:8000/v1/memories?limit=5&q=alpha&q=beta');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-user-id']).toBe('alice');
    expect(headers['x-daedalus-internal-token']).toBe('internal-secret');
    expect(headers.Cookie).toBe('nat-session=alice');
    expect(JSON.stringify(headers)).not.toContain('mallory');
    expect(init?.body).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ items: [] });
  });

  it('forwards an edit body to the encoded resource route', async () => {
    const { req, res } = call(
      'PATCH',
      ['memories', 'fact:1'],
      {},
      {
        text: 'Updated',
      },
    );

    await handler(req, res);

    const [url, init] = vi.mocked(fetchWithTimeout).mock.calls[0];
    expect(url).toBe('http://backend:8000/v1/memories/fact%3A1');
    expect(init).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ text: 'Updated' }),
    });
  });

  it.each([
    ['GET', ['banks', 'someone-else']],
    ['GET', ['memory', 'retain-turn']],
    ['DELETE', ['sources', '../someone-else']],
  ])('rejects %s %j before contacting the backend', async (method, path) => {
    const { req, res } = call(method, path);

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('rejects a method the mapped route does not allow', async () => {
    const { req, res } = call('DELETE', ['memories']);

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('does not contact the backend for an unauthenticated session', async () => {
    vi.mocked(requireAuthenticatedUser).mockResolvedValueOnce(null);
    const { req, res } = call('GET', ['memories']);

    await handler(req, res);

    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('reports an unreachable memory service without its transport error', async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 10.0.0.5:8000'),
    );
    const { req, res } = call('GET', ['sources']);

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Memory service is unavailable.',
    });
  });
});

describe('Memory Center API route allowlist', () => {
  it('maps only fixed identity-bound backend routes', () => {
    expect(resolveMemoryRoute(['memories'])).toEqual({
      methods: ['GET'],
      backendPath: '/v1/memories',
    });
    expect(resolveMemoryRoute(['memories', 'fact-1', 'invalidate'])).toEqual({
      methods: ['POST'],
      backendPath: '/v1/memories/fact-1/invalidate',
    });
    expect(resolveMemoryRoute(['sources', 'source-1'])).toEqual({
      methods: ['GET', 'DELETE'],
      backendPath: '/v1/memory-sources/source-1',
    });
    expect(resolveMemoryRoute(['pages'])).toEqual({
      methods: ['GET'],
      backendPath: '/v1/memory-pages',
    });
    expect(resolveMemoryRoute(['pages', 'kp-1'])).toEqual({
      methods: ['GET'],
      backendPath: '/v1/memory-pages/kp-1',
    });
  });

  it('rejects bank paths and unsafe resource identifiers', () => {
    expect(resolveMemoryRoute(['banks', 'someone-else'])).toBeNull();
    expect(resolveMemoryRoute(['sources', '../someone-else'])).toBeNull();
    expect(resolveMemoryRoute(['memories', 'fact/1'])).toBeNull();
    expect(resolveMemoryRoute(['pages', '../someone-else'])).toBeNull();
    expect(resolveMemoryRoute(['retain-turn'])).toBeNull();
  });
});
