// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({ resolve4: vi.fn() }));
vi.mock('@/server/session/redis', () => ({
  jsonDel: vi.fn(),
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  sessionKey: (parts: string[]) => parts.join(':'),
}));

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function configure(podPort = '8001') {
  vi.resetModules();
  vi.stubEnv('DEPLOYMENT_MODE', 'kubernetes');
  vi.stubEnv('BACKEND_HOST', 'fixture-backend');
  vi.stubEnv('BACKEND_NAMESPACE', 'fixture');
  vi.stubEnv('BACKEND_PORT', '8086');
  vi.stubEnv('BACKEND_POD_PORT', podPort);
  const dns = await import('node:dns/promises');
  vi.mocked(dns.resolve4).mockResolvedValue(['10.2.3.4'] as never);
  return {
    selection: await import('@/server/chat/backendSelection'),
    oauth: await import('@/server/mcpOAuth'),
  };
}

describe('backend Service and pod ports', () => {
  it('uses the container port for discovered pods and the Service port on DNS fallback', async () => {
    const { selection } = await configure();
    expect(await selection.resolveAsyncBackendBaseUrls()).toEqual([
      'http://10.2.3.4:8001',
    ]);
    const dns = await import('node:dns/promises');
    vi.mocked(dns.resolve4).mockRejectedValueOnce(new Error('DNS unavailable'));
    expect(await selection.resolveAsyncBackendBaseUrls()).toEqual([
      'http://fixture-backend-default.fixture.svc.cluster.local:8086',
    ]);
  });

  it('restricts each OAuth target to the port for that host kind', async () => {
    const { oauth } = await configure();
    expect(oauth.isAllowedOAuthBackendBaseUrl('http://10.2.3.4:8001')).toBe(
      true,
    );
    expect(oauth.isAllowedOAuthBackendBaseUrl('http://10.2.3.4:8086')).toBe(
      false,
    );
    expect(
      oauth.isAllowedOAuthBackendBaseUrl(
        'http://fixture-backend-default.fixture.svc.cluster.local:8086',
      ),
    ).toBe(true);
    expect(
      oauth.isAllowedOAuthBackendBaseUrl(
        'http://fixture-backend-default.fixture.svc.cluster.local:8001',
      ),
    ).toBe(false);
    expect(oauth.isAllowedOAuthBackendBaseUrl('http://203.0.113.8:8001')).toBe(
      false,
    );
  });

  it('preserves one-port configuration when no pod override is supplied', async () => {
    const { selection, oauth } = await configure('');
    expect(await selection.resolveAsyncBackendBaseUrls()).toEqual([
      'http://10.2.3.4:8086',
    ]);
    expect(oauth.isAllowedOAuthBackendBaseUrl('http://10.2.3.4:8086')).toBe(
      true,
    );
  });
});
