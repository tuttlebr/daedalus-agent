import {
  ApiError,
  ConflictError,
  apiGet,
  apiPut,
  apiPost,
  apiDelete,
  apiBase,
} from '@/utils/app/api';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn<typeof fetch>();
const path = '/api/conversations/conv-1';
const body = { name: 'Updated' };
const methods = [
  { method: 'GET', call: () => apiGet(path), body: undefined },
  { method: 'PUT', call: () => apiPut(path, body), body },
  { method: 'POST', call: () => apiPost(path, body), body },
  { method: 'DELETE', call: () => apiDelete(path), body: undefined },
];

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ConflictError', () => {
  it.each([null, { id: 'conv-1', messages: [{ content: 'hello' }] }])(
    'retains the server state: %j',
    (serverState) => {
      const error = new ConflictError(serverState);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        name: 'ConflictError',
        message: 'Conflict: server has newer data',
        status: 409,
        kind: 'conflict',
      });
      expect(error.serverState).toBe(serverState);
      expect(error.body).toBe(serverState);
    },
  );
});

describe('apiBase', () => {
  it('uses the browser origin', () => {
    expect(apiBase()).toBe(window.location.origin);
  });

  it('uses the configured server origin, with a local fallback', () => {
    vi.stubGlobal('window', undefined);
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://app.example.test');
    expect(apiBase()).toBe('https://app.example.test');
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', '');
    expect(apiBase()).toBe('http://localhost:3000');
  });
});

describe.each(methods)('$method requests', ({ method, call, body }) => {
  it('sends authenticated JSON and returns the decoded response', async () => {
    const responseBody = { id: 'conv-1', success: true };
    mockFetch.mockResolvedValue(Response.json(responseBody));

    await expect(call()).resolves.toEqual(responseBody);
    expect(mockFetch).toHaveBeenCalledExactlyOnceWith(`${apiBase()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  });

  it.each([
    [400, 'client'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'client'],
    [500, 'server'],
  ])('classifies HTTP %i as %s', async (status, kind) => {
    const errorBody = { error: 'Request rejected' };
    mockFetch.mockResolvedValue(
      Response.json(errorBody, { status, statusText: 'Rejected' }),
    );

    await expect(call()).rejects.toMatchObject({
      name: 'ApiError',
      status,
      kind,
      body: errorBody,
      message: `${method} ${path} failed: ${status} Rejected`,
    });
  });

  it('keeps the HTTP error when its body is not JSON', async () => {
    mockFetch.mockResolvedValue(new Response('unavailable', { status: 503 }));
    await expect(call()).rejects.toMatchObject({
      status: 503,
      kind: 'server',
      body: undefined,
    });
  });

  it('reports a failed fetch as a network error', async () => {
    const cause = new TypeError('Failed to fetch');
    mockFetch.mockRejectedValue(cause);
    await expect(call()).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      kind: 'network',
      body: cause,
      message: `${method} ${path} failed: Failed to fetch`,
    });
  });

  it('preserves an existing API error from fetch', async () => {
    const error = new ApiError('session expired', 401, 'auth');
    mockFetch.mockRejectedValue(error);
    await expect(call()).rejects.toBe(error);
  });

  it('propagates invalid successful JSON without calling it a network error', async () => {
    mockFetch.mockResolvedValue(new Response('not JSON', { status: 200 }));
    await expect(call()).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe('method-specific responses', () => {
  it('returns the conflicting server copy for PUT', async () => {
    const serverState = { id: 'conv-1', updatedAt: 5000 };
    mockFetch.mockResolvedValue(
      Response.json({ serverState }, { status: 409 }),
    );
    await expect(apiPut(path, body)).rejects.toMatchObject({
      name: 'ConflictError',
      serverState,
      status: 409,
    });
  });

  it('keeps PUT conflict recovery explicit when the error body is unreadable', async () => {
    mockFetch.mockResolvedValue(new Response('not JSON', { status: 409 }));
    await expect(apiPut(path, body)).rejects.toMatchObject({
      name: 'ConflictError',
      serverState: undefined,
    });
  });

  it.each(methods.filter(({ method }) => method !== 'PUT'))(
    'retains ordinary API errors for $method conflicts',
    async ({ call }) => {
      const errorBody = { serverState: { id: 'conv-1' } };
      mockFetch.mockResolvedValue(Response.json(errorBody, { status: 409 }));
      await expect(call()).rejects.toMatchObject({
        name: 'ApiError',
        status: 409,
        kind: 'conflict',
        body: errorBody,
      });
    },
  );

  it.each(methods.filter(({ method }) => method !== 'GET'))(
    'accepts an empty 204 response for $method without reading JSON',
    async ({ call }) => {
      const response = new Response(null, { status: 204 });
      const readJson = vi.spyOn(response, 'json');
      mockFetch.mockResolvedValue(response);
      await expect(call()).resolves.toBeUndefined();
      expect(readJson).not.toHaveBeenCalled();
    },
  );

  it('requires a JSON response for GET', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiGet(path)).rejects.toBeInstanceOf(SyntaxError);
  });
});
