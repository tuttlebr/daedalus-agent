import { describe, expect, it, afterEach, vi } from 'vitest';

const ENV_KEYS = [
  'BACKEND_API_PATH',
  'BACKEND_HOST',
  'BACKEND_NAMESPACE',
  'BACKEND_PORT',
  'DEPLOYMENT_MODE',
  'KUBERNETES_SERVICE_HOST',
  'NAMESPACE',
  'NEXT_PUBLIC_HTTP_CHAT_COMPLETION_URL',
  'POD_NAMESPACE',
];

async function importBackendApiWithEnv(
  env: Record<string, string | undefined>,
) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, '');
  }
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value ?? '');
  }
  return import('@/utils/app/backendApi');
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('backendApi configuration', () => {
  it('defaults to the OpenAI-compatible chat completions path', async () => {
    const backendApi = await importBackendApiWithEnv({
      BACKEND_HOST: 'backend',
      BACKEND_PORT: '8000',
      DEPLOYMENT_MODE: 'local',
    });

    expect(backendApi.BACKEND_API_PATH).toBe('/v1/chat/completions');
    expect(backendApi.getDefaultChatCompletionUrl()).toBe(
      'http://backend:8000/v1/chat/completions',
    );
  });

  it('builds Kubernetes service URLs from a host-only backend name', async () => {
    const backendApi = await importBackendApiWithEnv({
      BACKEND_HOST: 'daedalus-backend',
      BACKEND_NAMESPACE: 'prod',
      BACKEND_PORT: '8000',
      DEPLOYMENT_MODE: 'kubernetes',
    });

    expect(backendApi.getBackendHost()).toBe(
      'daedalus-backend-default.prod.svc.cluster.local',
    );
    expect(backendApi.buildBackendUrlForMode()).toBe(
      'http://daedalus-backend-default.prod.svc.cluster.local:8000/v1/chat/completions',
    );
  });

  it('honors the explicit public chat completion URL override', async () => {
    const backendApi = await importBackendApiWithEnv({
      DEPLOYMENT_MODE: 'local',
      NEXT_PUBLIC_HTTP_CHAT_COMPLETION_URL: 'https://api.example.test/chat',
    });

    expect(backendApi.getDefaultChatCompletionUrl()).toBe(
      'https://api.example.test/chat',
    );
  });
});
