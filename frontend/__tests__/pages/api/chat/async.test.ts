import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve4: vi.fn(),
  fetchWithTimeout: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  default: {
    resolve4: mocks.resolve4,
  },
  resolve4: mocks.resolve4,
}));

vi.mock('@/pages/api/session/redis', () => ({
  getPublisher: vi.fn(() => ({ publish: vi.fn().mockResolvedValue(undefined) })),
  getRedis: vi.fn(() => ({
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn().mockResolvedValue(1),
  })),
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  jsonDel: vi.fn(),
  setStreamingState: vi.fn(),
  clearStreamingState: vi.fn(),
}));

vi.mock('@/utils/sync/publish', () => ({
  publishStreamingState: vi.fn().mockResolvedValue(undefined),
  publishConversationUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

vi.mock('@/utils/auth/session', () => ({
  getSession: vi.fn().mockResolvedValue({ username: 'testuser' }),
}));

import {
  fetchNatJobStatus,
  resolveAsyncBackendBaseUrls,
} from '@/pages/api/chat/async';

describe('chat/async backend pinning helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BACKEND_HOST = 'daedalus-backend';
    process.env.BACKEND_NAMESPACE = 'daedalus';
    process.env.BACKEND_PORT = '8000';
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    delete process.env.DEPLOYMENT_MODE;
  });

  it('resolves pinned backend pod base URLs from the headless service', async () => {
    mocks.resolve4.mockResolvedValue([
      '10.0.2.61',
      '10.0.3.154',
      '10.0.2.61',
    ]);

    const baseUrls = await resolveAsyncBackendBaseUrls();

    expect(mocks.resolve4).toHaveBeenCalledWith(
      'daedalus-backend-default-pods.daedalus.svc.cluster.local',
    );
    expect(baseUrls).toHaveLength(2);
    expect(baseUrls).toEqual(
      expect.arrayContaining([
        'http://10.0.2.61:8000',
        'http://10.0.3.154:8000',
      ]),
    );
  });

  it('uses the stored natBaseUrl when polling job status', async () => {
    const json = vi.fn().mockResolvedValue({
      job_id: 'job-123',
      status: 'running',
      error: null,
      output: null,
      created_at: '',
      updated_at: '',
      expires_at: '',
    });
    mocks.fetchWithTimeout.mockResolvedValue({
      ok: true,
      status: 200,
      json,
    });

    await fetchNatJobStatus('job-123', {
      jobId: 'job-123',
      natBaseUrl: 'http://10.0.2.61:8000',
      messages: [],
      additionalProps: {},
      userId: 'testuser',
    } as any);

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'http://10.0.2.61:8000/v1/workflow/async/job/job-123',
      {},
      30000,
    );
  });

  it('treats legacy shared-service 404s as retryable instead of terminal', async () => {
    mocks.fetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await fetchNatJobStatus('job-legacy', {
      jobId: 'job-legacy',
      messages: [],
      additionalProps: {},
      userId: 'testuser',
    } as any);

    expect(result).toBeNull();
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'http://daedalus-backend-default.daedalus.svc.cluster.local:8000/v1/workflow/async/job/job-legacy',
      {},
      30000,
    );
  });
});
