import handler from '@/pages/api/images/jobs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, any>(),
  buildBackendUrl: vi.fn(),
  getBackendHost: vi.fn(),
  getOrSetSessionId: vi.fn(),
  requireAuthenticatedUser: vi.fn(),
  resolveTimezoneFromHeaders: vi.fn(),
  withInternalBackendAuth: vi.fn(),
  withTimezoneHeader: vi.fn(),
  enforceRateLimit: vi.fn(),
  ruleFromEnv: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/utils/app/backendApi', () => ({
  buildBackendUrl: mocks.buildBackendUrl,
  getBackendHost: mocks.getBackendHost,
}));

vi.mock('@/utils/server/backendAuth', () => ({
  resolveTimezoneFromHeaders: mocks.resolveTimezoneFromHeaders,
  withInternalBackendAuth: mocks.withInternalBackendAuth,
  withTimezoneHeader: mocks.withTimezoneHeader,
}));

vi.mock('@/server/session/_utils', () => ({
  getOrSetSessionId: mocks.getOrSetSessionId,
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
}));

vi.mock('@/server/session/redis', () => ({
  jsonGet: vi.fn(async (key: string) => mocks.store.get(key) ?? null),
  jsonSetWithExpiry: vi.fn(async (key: string, value: any) => {
    mocks.store.set(key, value);
  }),
  sessionKey: vi.fn((parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
  ),
}));

vi.mock('@/server/rateLimit', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  ruleFromEnv: mocks.ruleFromEnv,
}));

function createMockReqRes(
  method: string,
  body: unknown = {},
  query: Record<string, string> = {},
) {
  const req = {
    method,
    body,
    query,
    headers: { timezone: 'America/Detroit' },
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
  return { req, res };
}

async function drainUntil(predicate: () => boolean) {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
}

describe('/api/images/jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    mocks.buildBackendUrl.mockImplementation(
      ({ pathOverride }: { pathOverride: string }) =>
        `http://backend.test${pathOverride}`,
    );
    mocks.getBackendHost.mockReturnValue('http://backend.test');
    mocks.getOrSetSessionId.mockReturnValue('session-1');
    mocks.requireAuthenticatedUser.mockResolvedValue({ username: 'alice' });
    mocks.resolveTimezoneFromHeaders.mockReturnValue('America/Detroit');
    mocks.withTimezoneHeader.mockImplementation(
      (headers: Record<string, string>, timezone: string) => ({
        ...headers,
        'x-timezone': timezone,
      }),
    );
    mocks.withInternalBackendAuth.mockImplementation(
      (headers: Record<string, string>) => headers,
    );
    mocks.ruleFromEnv.mockReturnValue({
      name: 'image-job',
      limit: 5,
      windowSeconds: 60,
    });
    mocks.enforceRateLimit.mockResolvedValue(true);
    vi.stubGlobal('fetch', mocks.fetch);
  });

  it('returns a job id immediately and completes generate work in the background', async () => {
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          imageIds: ['final-1'],
          model: 'gpt-image-2',
          prompt: 'a product photo',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const { req, res } = createMockReqRes('POST', {
      mode: 'generate',
      prompt: '  a product photo  ',
      model: 'gpt-image-2',
      quality: 'medium',
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      jobId: expect.any(String),
      status: 'queued',
    });
    const jobId = res.json.mock.calls[0][0].jobId;

    await drainUntil(
      () => mocks.store.get(`image-job:${jobId}`)?.status === 'completed',
    );

    const [, init] = mocks.fetch.mock.calls[0];
    expect(mocks.fetch.mock.calls[0][0]).toBe(
      'http://backend.test/v1/images/generate',
    );
    expect(JSON.parse(init.body)).toMatchObject({
      prompt: 'a product photo',
      model: 'gpt-image-2',
      quality: 'medium',
      sessionId: 'session-1',
      user: 'alice',
      stream: true,
      partial_images: 2,
    });
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-session-id': 'session-1',
      'x-user-id': 'alice',
      'x-timezone': 'America/Detroit',
    });

    const status = mocks.store.get(`image-job:${jobId}`);
    expect(status.outputImageIds).toEqual(['final-1']);
    expect(status.historyEntry.outputImageIds).toEqual(['final-1']);
    expect(status.historyEntry.id).toBe(
      mocks.store.get('user:alice:imagePanelHistory')[0].id,
    );
    expect(mocks.store.get('user:alice:imagePanelHistory')[0]).toMatchObject({
      prompt: 'a product photo',
      outputImageIds: ['final-1'],
    });
  });

  it('records streaming partials before the completed image ids', async () => {
    const stream = [
      'event: partial',
      'data: {"type":"partial","imageId":"partial-1","imageIds":["partial-1"]}',
      '',
      'event: completed',
      'data: {"type":"completed","imageIds":["final-1"],"model":"gpt-image-2","prompt":"a cat"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    mocks.fetch.mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const { req, res } = createMockReqRes('POST', {
      mode: 'generate',
      prompt: 'a cat',
      model: 'gpt-image-2',
    });

    await handler(req, res);
    const jobId = res.json.mock.calls[0][0].jobId;
    await drainUntil(
      () => mocks.store.get(`image-job:${jobId}`)?.status === 'completed',
    );

    const status = mocks.store.get(`image-job:${jobId}`);
    expect(status.partialImageIds).toEqual(['partial-1']);
    expect(status.outputImageIds).toEqual(['final-1']);
  });

  it('keeps every partial image emitted by the backend stream', async () => {
    const stream = [
      'event: partial',
      'data: {"type":"partial","imageId":"partial-1"}',
      '',
      'event: partial',
      'data: {"type":"partial","imageId":"partial-2"}',
      '',
      'event: completed',
      'data: {"type":"completed","imageIds":["final-1"]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    mocks.fetch.mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const { req, res } = createMockReqRes('POST', {
      mode: 'generate',
      prompt: 'a cat',
      model: 'gpt-image-2',
    });

    await handler(req, res);
    const jobId = res.json.mock.calls[0][0].jobId;
    await drainUntil(
      () => mocks.store.get(`image-job:${jobId}`)?.status === 'completed',
    );

    expect(mocks.store.get(`image-job:${jobId}`).partialImageIds).toEqual([
      'partial-1',
      'partial-2',
    ]);
  });

  it('parses CRLF-delimited SSE events from an upstream proxy', async () => {
    const stream = [
      'event: partial',
      'data: {"type":"partial","imageId":"partial-1"}',
      '',
      'event: completed',
      'data: {"type":"completed","imageIds":["final-1"]}',
      '',
      'data: [DONE]',
      '',
    ].join('\r\n');
    mocks.fetch.mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }),
    );
    const { req, res } = createMockReqRes('POST', {
      mode: 'generate',
      prompt: 'a cat',
      model: 'gpt-image-2',
    });

    await handler(req, res);
    const jobId = res.json.mock.calls[0][0].jobId;
    await drainUntil(
      () => mocks.store.get(`image-job:${jobId}`)?.status === 'completed',
    );

    expect(mocks.store.get(`image-job:${jobId}`)).toMatchObject({
      partialImageIds: ['partial-1'],
      outputImageIds: ['final-1'],
    });
  });

  it('runs edit jobs against the edit backend with input and mask refs', async () => {
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          imageIds: ['edited-1'],
          model: 'gpt-image-2',
          prompt: 'change the label color',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const imageRefs = [
      { imageId: 'input-1', sessionId: 'session-1', mimeType: 'image/png' },
    ];
    const maskRef = {
      imageId: 'mask-1',
      sessionId: 'session-1',
      mimeType: 'image/png',
    };
    const { req, res } = createMockReqRes('POST', {
      mode: 'edit',
      prompt: 'change the label color',
      model: 'gpt-image-2',
      imageRefs,
      maskRef,
    });

    await handler(req, res);
    const jobId = res.json.mock.calls[0][0].jobId;
    await drainUntil(
      () => mocks.store.get(`image-job:${jobId}`)?.status === 'completed',
    );

    const [, init] = mocks.fetch.mock.calls[0];
    expect(mocks.fetch.mock.calls[0][0]).toBe(
      'http://backend.test/v1/images/edit',
    );
    expect(JSON.parse(init.body)).toMatchObject({
      imageRefs,
      maskRef,
      stream: true,
      partial_images: 2,
    });
    expect(mocks.store.get(`image-job:${jobId}`).outputImageIds).toEqual([
      'edited-1',
    ]);
  });

  it('rejects edit jobs without input images before calling the backend', async () => {
    const { req, res } = createMockReqRes('POST', {
      mode: 'edit',
      prompt: 'change the label color',
      model: 'gpt-image-2',
      imageRefs: [],
    });

    await handler(req, res);

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Add at least one input image or switch to Generate.',
    });
  });

  it('returns only active jobs owned by the current user', async () => {
    mocks.store.set('user:alice:imageJobs', ['running', 'done', 'other-user']);
    mocks.store.set('image-job:running', {
      jobId: 'running',
      userId: 'alice',
      status: 'running',
    });
    mocks.store.set('image-job:done', {
      jobId: 'done',
      userId: 'alice',
      status: 'completed',
    });
    mocks.store.set('image-job:other-user', {
      jobId: 'other-user',
      userId: 'bob',
      status: 'running',
    });
    const { req, res } = createMockReqRes('GET', {}, { active: '1' });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      jobs: [expect.objectContaining({ jobId: 'running' })],
    });
  });

  it('limits a user to two in-progress image jobs', async () => {
    mocks.store.set('user:alice:imageJobs', ['one', 'two']);
    mocks.store.set('image-job:one', {
      jobId: 'one',
      userId: 'alice',
      status: 'running',
    });
    mocks.store.set('image-job:two', {
      jobId: 'two',
      userId: 'alice',
      status: 'queued',
    });
    const { req, res } = createMockReqRes('POST', {
      mode: 'generate',
      prompt: 'a cat',
      model: 'gpt-image-2',
    });

    await handler(req, res);

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('two image jobs'),
      }),
    );
  });
});
