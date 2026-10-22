import { describe, expect, it, afterEach, vi } from 'vitest';

const ENV_KEYS = [
  'BACKEND_API_PATH',
  'BACKEND_HOST',
  'BACKEND_NAMESPACE',
  'BACKEND_PORT',
  'BACKEND_POD_PORT',
  'DEPLOYMENT_MODE',
  'KUBERNETES_SERVICE_HOST',
  'NAMESPACE',
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
  it.each([
    [{}, 'daedalus-backend'],
    [{ BACKEND_HOST: 'backend', POD_NAMESPACE: 'prod' }, 'backend'],
  ])(
    'uses the same local host for service and discovery: %j',
    async (env, host) => {
      const backendApi = await importBackendApiWithEnv(env);
      expect(backendApi.getBackendHost()).toBe(host);
      expect(backendApi.getBackendPodDiscoveryHost()).toBe(host);
    },
  );

  describe.each([
    { DEPLOYMENT_MODE: 'kubernetes' },
    { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
  ])('Kubernetes detection: %j', (mode) => {
    it.each([
      [
        {
          BACKEND_NAMESPACE: 'backend-ns',
          POD_NAMESPACE: 'pod-ns',
          NAMESPACE: 'legacy-ns',
        },
        'backend-ns',
      ],
      [{ POD_NAMESPACE: 'pod-ns', NAMESPACE: 'legacy-ns' }, 'pod-ns'],
      [{ NAMESPACE: 'legacy-ns' }, 'legacy-ns'],
      [{}, 'daedalus'],
    ])(
      'shares namespace precedence for both hosts: %j',
      async (env, namespace) => {
        const backendApi = await importBackendApiWithEnv({
          ...mode,
          ...env,
          BACKEND_HOST: 'backend',
        });
        expect(backendApi.getBackendHost()).toBe(
          `backend-default.${namespace}.svc.cluster.local`,
        );
        expect(backendApi.getBackendPodDiscoveryHost()).toBe(
          `backend-default-pods.${namespace}.svc.cluster.local`,
        );
      },
    );
  });

  it('preserves separate service and pod port overrides', async () => {
    const backendApi = await importBackendApiWithEnv({
      BACKEND_HOST: 'backend',
      BACKEND_PORT: '8080',
      BACKEND_POD_PORT: '8000',
      BACKEND_API_PATH: '/custom/chat',
    });
    expect(backendApi.buildBackendBaseUrlForMode()).toBe('http://backend:8080');
    expect(
      backendApi.buildBackendUrl({
        backendHost: '127.0.0.1',
        port: backendApi.BACKEND_POD_PORT,
      }),
    ).toBe('http://127.0.0.1:8000/custom/chat');
    expect(
      backendApi.buildBackendUrlFromBase('https://backend/', '/health'),
    ).toBe('https://backend/health');
  });

  it('defaults to the OpenAI-compatible chat completions path', async () => {
    const backendApi = await importBackendApiWithEnv({
      BACKEND_HOST: 'backend',
      BACKEND_PORT: '8000',
      DEPLOYMENT_MODE: 'local',
    });

    expect(
      backendApi.buildBackendUrlFromBase(
        backendApi.buildBackendBaseUrlForMode(),
      ),
    ).toBe('http://backend:8000/v1/chat/completions');
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
    expect(
      backendApi.buildBackendUrlFromBase(
        backendApi.buildBackendBaseUrlForMode(),
      ),
    ).toBe(
      'http://daedalus-backend-default.prod.svc.cluster.local:8000/v1/chat/completions',
    );
  });
});
