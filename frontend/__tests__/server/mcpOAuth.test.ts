import {
  deleteOAuthCallbackTarget,
  isAllowedOAuthBackendBaseUrl,
  isOAuthCallbackOwner,
  loadOAuthCallbackTarget,
  saveOAuthCallbackTarget,
} from '@/server/mcpOAuth';
import { jsonDel, jsonGet, jsonSetWithExpiry } from '@/server/session/redis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/session/redis', () => ({
  jsonDel: vi.fn(),
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  sessionKey: vi.fn((parts: string[]) => parts.join(':')),
}));

describe('MCP OAuth callback routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores a private backend target under a hashed, expiring state key', async () => {
    await saveOAuthCallbackTarget(
      'browser-state-secret',
      'http://10.2.3.4:8000',
      'job-123',
    );

    expect(jsonSetWithExpiry).toHaveBeenCalledTimes(1);
    const [key, target, ttl] = vi.mocked(jsonSetWithExpiry).mock.calls[0];
    expect(key).toMatch(/^mcp-oauth-callback:[a-f0-9]{64}$/);
    expect(key).not.toContain('browser-state-secret');
    expect(target).toMatchObject({
      backendBaseUrl: 'http://10.2.3.4:8000',
      jobId: 'job-123',
    });
    expect(ttl).toBe(660);
  });

  it('rejects public, credential-bearing, and wrong-port callback targets', () => {
    expect(isAllowedOAuthBackendBaseUrl('https://10.2.3.4:8000')).toBe(false);
    expect(isAllowedOAuthBackendBaseUrl('http://203.0.113.9:8000')).toBe(false);
    expect(isAllowedOAuthBackendBaseUrl('http://user@10.2.3.4:8000')).toBe(
      false,
    );
    expect(isAllowedOAuthBackendBaseUrl('http://10.2.3.4:9000')).toBe(false);
    expect(isAllowedOAuthBackendBaseUrl('http://10.2.3.4:8000/path')).toBe(
      false,
    );
  });

  it('loads only a valid stored target and deletes it by hashed state', async () => {
    vi.mocked(jsonGet).mockResolvedValue({
      backendBaseUrl: 'http://172.20.4.9:8000',
      jobId: 'job-123',
      createdAt: 123,
    });

    await expect(loadOAuthCallbackTarget('state-a')).resolves.toEqual({
      backendBaseUrl: 'http://172.20.4.9:8000',
      jobId: 'job-123',
      createdAt: 123,
    });
    await deleteOAuthCallbackTarget('state-a');

    expect(vi.mocked(jsonGet).mock.calls[0][0]).toBe(
      vi.mocked(jsonDel).mock.calls[0][0],
    );
  });

  it('fails closed for a corrupted Redis callback target', async () => {
    vi.mocked(jsonGet).mockResolvedValue({
      backendBaseUrl: 'http://169.254.169.254:8000',
      jobId: 'job-123',
      createdAt: 123,
    });

    await expect(loadOAuthCallbackTarget('state-b')).resolves.toBeNull();
  });

  it('records the initiating user and rejects malformed owners', async () => {
    await saveOAuthCallbackTarget(
      'browser-state-secret',
      'http://10.2.3.4:8000',
      'approval_request_12345',
      'alice',
    );
    expect(vi.mocked(jsonSetWithExpiry).mock.calls[0][1]).toMatchObject({
      jobId: 'approval_request_12345',
      userId: 'alice',
    });

    for (const owner of ['', 'x'.repeat(257)]) {
      await expect(
        saveOAuthCallbackTarget(
          'browser-state-secret',
          'http://10.2.3.4:8000',
          'job-123',
          owner,
        ),
      ).rejects.toThrow('OAuth callback owner is invalid');
    }
    vi.mocked(jsonGet).mockResolvedValue({
      backendBaseUrl: 'http://10.2.3.4:8000',
      jobId: 'job-123',
      userId: 42,
      createdAt: 123,
    });
    await expect(loadOAuthCallbackTarget('state-c')).resolves.toBeNull();
  });

  it('authorizes only the recorded owner, falling back to the chat job owner', async () => {
    const target = {
      backendBaseUrl: 'http://10.2.3.4:8000',
      jobId: 'job-123',
      createdAt: 123,
    };
    vi.mocked(jsonGet).mockResolvedValue({ userId: 'bob' });

    // A recorded owner is authoritative and needs no job lookup.
    await expect(
      isOAuthCallbackOwner({ ...target, userId: 'alice' }, 'alice'),
    ).resolves.toBe(true);
    await expect(
      isOAuthCallbackOwner({ ...target, userId: 'alice' }, 'bob'),
    ).resolves.toBe(false);
    expect(jsonGet).not.toHaveBeenCalled();

    // Older stream workers record only the job; its request names the owner.
    await expect(isOAuthCallbackOwner(target, 'bob')).resolves.toBe(true);
    await expect(isOAuthCallbackOwner(target, 'alice')).resolves.toBe(false);
    expect(jsonGet).toHaveBeenCalledWith('async-job-request:job-123');
    vi.mocked(jsonGet).mockResolvedValue(null);
    await expect(isOAuthCallbackOwner(target, 'bob')).resolves.toBe(false);
    await expect(isOAuthCallbackOwner(target, '')).resolves.toBe(false);
  });
});
