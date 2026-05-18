import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, ConflictError, apiGet, apiPut, apiPost, apiDelete, apiBase } from '@/utils/app/api';

// --- Mock fetch ---

const mockFetch = vi.fn();
global.fetch = mockFetch;

// --- Helpers ---

function mockResponse(status: number, body: any = {}, ok?: boolean) {
  return {
    ok: ok !== undefined ? ok : status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    json: vi.fn().mockResolvedValue(body),
  };
}

// --- Tests ---

describe('ConflictError', () => {
  it('has serverState property', () => {
    const serverState = { id: 'conv-1', updatedAt: 5000 };
    const error = new ConflictError(serverState);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.name).toBe('ConflictError');
    expect(error.message).toBe('Conflict: server has newer data');
    expect(error.serverState).toBe(serverState);
    expect(error.kind).toBe('conflict');
    expect(error.status).toBe(409);
  });

  it('preserves complex serverState object', () => {
    const serverState = {
      id: 'conv-1',
      messages: [{ role: 'user', content: 'hello' }],
      updatedAt: 9999,
    };
    const error = new ConflictError(serverState);

    expect(error.serverState).toEqual(serverState);
    expect(error.serverState.messages).toHaveLength(1);
  });

  it('can hold null serverState', () => {
    const error = new ConflictError(null);
    expect(error.serverState).toBeNull();
  });
});

describe('apiBase', () => {
  const originalWindow = global.window;

  afterEach(() => {
    // Restore window
    if (originalWindow !== undefined) {
      global.window = originalWindow;
    }
    vi.unstubAllEnvs();
  });

  it('returns window.location.origin in browser context', () => {
    // jsdom environment already provides window
    expect(apiBase()).toBe(window.location.origin);
  });
});

describe('apiGet', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns parsed JSON on success', async () => {
    const responseBody = { id: 'conv-1', name: 'Test' };
    mockFetch.mockResolvedValue(mockResponse(200, responseBody));

    const result = await apiGet<typeof responseBody>('/api/conversations/conv-1');

    expect(result).toEqual(responseBody);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/conversations/conv-1'),
      expect.objectContaining({
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      }),
    );
  });

  it('throws ApiError with kind=server on 5xx', async () => {
    mockFetch.mockResolvedValue(mockResponse(500, { error: 'Server error' }));

    try {
      await apiGet('/api/test');
      expect.fail('Expected ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(500);
      expect((error as ApiError).kind).toBe('server');
      expect((error as ApiError).message).toContain('GET /api/test failed: 500');
    }
  });

  it('throws ApiError with kind=client on 4xx', async () => {
    mockFetch.mockResolvedValue(mockResponse(404));

    try {
      await apiGet('/api/missing');
      expect.fail('Expected ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
      expect((error as ApiError).kind).toBe('client');
    }
  });

  it('throws ApiError with kind=auth on 401', async () => {
    mockFetch.mockResolvedValue(mockResponse(401));

    try {
      await apiGet('/api/protected');
      expect.fail('Expected ApiError');
    } catch (error) {
      expect((error as ApiError).kind).toBe('auth');
    }
  });

  it('throws ApiError with kind=network on fetch rejection', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    try {
      await apiGet('/api/test');
      expect.fail('Expected ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).kind).toBe('network');
      expect((error as ApiError).status).toBe(0);
    }
  });
});

describe('apiPut', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns parsed JSON on success', async () => {
    const responseBody = { success: true };
    mockFetch.mockResolvedValue(mockResponse(200, responseBody));

    const result = await apiPut('/api/conversations/conv-1', { name: 'Updated' });

    expect(result).toEqual(responseBody);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/conversations/conv-1'),
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: 'Updated' }),
      }),
    );
  });

  it('throws ConflictError on 409 response', async () => {
    const serverState = { id: 'conv-1', updatedAt: 5000 };
    mockFetch.mockResolvedValue(mockResponse(409, { serverState }));

    try {
      await apiPut('/api/conversations/conv-1', { name: 'Stale' });
      // Should not reach here
      expect.fail('Expected ConflictError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).serverState).toEqual(serverState);
      expect((error as ConflictError).message).toBe('Conflict: server has newer data');
    }
  });

  it('throws ApiError on other failures (500)', async () => {
    mockFetch.mockResolvedValue(mockResponse(500));

    try {
      await apiPut('/api/conversations/conv-1', { name: 'Test' });
      expect.fail('Expected ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(500);
      expect((error as ApiError).kind).toBe('server');
    }
  });

  it('throws ApiError with kind=auth on 403', async () => {
    mockFetch.mockResolvedValue(mockResponse(403));

    try {
      await apiPut('/api/conversations/conv-1', { name: 'Test' });
      expect.fail('Expected ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).kind).toBe('auth');
    }
  });

  it('returns undefined for 204 No Content', async () => {
    mockFetch.mockResolvedValue(mockResponse(204, undefined, true));

    const result = await apiPut('/api/conversations/conv-1', { name: 'Test' });

    expect(result).toBeUndefined();
  });
});

describe('apiPost', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns parsed JSON on success', async () => {
    const responseBody = { id: 'new-id', success: true };
    mockFetch.mockResolvedValue(mockResponse(201, responseBody, true));

    const result = await apiPost('/api/push/subscribe', {
      endpoint: 'https://push.example.com',
    });

    expect(result).toEqual(responseBody);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/push/subscribe'),
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ endpoint: 'https://push.example.com' }),
      }),
    );
  });

  it('throws ApiError on non-OK response', async () => {
    mockFetch.mockResolvedValue(mockResponse(400));

    try {
      await apiPost('/api/push/subscribe', { invalid: true });
      expect.fail('Expected ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(400);
      expect((error as ApiError).kind).toBe('client');
    }
  });

  it('returns undefined for 204 No Content', async () => {
    mockFetch.mockResolvedValue(mockResponse(204, undefined, true));

    const result = await apiPost('/api/test', { data: 'value' });

    expect(result).toBeUndefined();
  });
});

describe('apiDelete', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns parsed JSON on success', async () => {
    const responseBody = { success: true };
    mockFetch.mockResolvedValue(mockResponse(200, responseBody));

    const result = await apiDelete('/api/conversations/conv-1');

    expect(result).toEqual(responseBody);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/conversations/conv-1'),
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      }),
    );
  });

  it('throws ApiError on non-OK response', async () => {
    mockFetch.mockResolvedValue(mockResponse(404, {}, false));

    try {
      await apiDelete('/api/conversations/missing');
      expect.fail('Expected ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
      expect((error as ApiError).kind).toBe('client');
    }
  });

  it('returns undefined for 204 No Content', async () => {
    mockFetch.mockResolvedValue(mockResponse(204, undefined, true));

    const result = await apiDelete('/api/conversations/conv-1');

    expect(result).toBeUndefined();
  });

  it('does not send a body', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { success: true }));

    await apiDelete('/api/test');

    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.body).toBeUndefined();
  });
});
