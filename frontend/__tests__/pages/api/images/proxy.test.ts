import editHandler from '@/pages/api/images/edit';
import generateHandler from '@/pages/api/images/generate';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildBackendUrl: vi.fn(),
  getBackendHost: vi.fn(),
  postJsonToBackend: vi.fn(),
  getOrSetSessionId: vi.fn(),
  requireAuthenticatedUser: vi.fn(),
  resolveTimezoneFromHeaders: vi.fn(),
  withInternalBackendAuth: vi.fn(),
  withTimezoneHeader: vi.fn(),
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

vi.mock('@/utils/server/httpProxy', () => ({
  postJsonToBackend: mocks.postJsonToBackend,
}));

vi.mock('@/server/session/_utils', () => ({
  getOrSetSessionId: mocks.getOrSetSessionId,
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
}));

function createMockReqRes(method: string, body: unknown = {}) {
  const req = {
    method,
    body,
    headers: {
      timezone: 'America/Detroit',
    },
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
  return { req, res };
}

describe('/api/images generate/edit proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.postJsonToBackend.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({
        imageIds: ['abc-123'],
        model: 'gpt-image-2',
        prompt: 'a product photo',
      }),
    });
  });

  it('cleans generate params and forwards user/session context', async () => {
    const { req, res } = createMockReqRes('POST', {
      prompt: '  a product photo  ',
      model: 'gpt-image-2',
      n: 99,
      quality: 'high',
      size: '2048x1152',
      output_format: 'png',
      output_compression: 50,
      background: 'transparent',
      moderation: 'low',
      input_fidelity: 'high',
      apiKey: 'browser-secret',
    });

    await generateHandler(req, res);

    expect(mocks.buildBackendUrl).toHaveBeenCalledWith({
      backendHost: 'http://backend.test',
      pathOverride: '/v1/images/generate',
    });
    const [url, body, headers, timeoutMs] =
      mocks.postJsonToBackend.mock.calls[0];
    expect(url).toBe('http://backend.test/v1/images/generate');
    expect(JSON.parse(body)).toEqual({
      prompt: 'a product photo',
      model: 'gpt-image-2',
      n: 8,
      quality: 'high',
      size: '2048x1152',
      output_format: 'png',
      moderation: 'low',
      sessionId: 'session-1',
      user: 'alice',
    });
    expect(headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-session-id': 'session-1',
      'x-user-id': 'alice',
      'x-timezone': 'America/Detroit',
    });
    expect(timeoutMs).toBe(180_000);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('forwards edit image refs and optional mask refs', async () => {
    const imageRefs = [
      {
        imageId: 'input-1',
        sessionId: 'session-1',
        mimeType: 'image/png',
      },
    ];
    const maskRef = {
      imageId: 'mask-1',
      sessionId: 'session-1',
      mimeType: 'image/png',
    };
    const { req, res } = createMockReqRes('POST', {
      prompt: 'Change the label color',
      model: 'gpt-image-2',
      quality: 'high',
      imageRefs,
      maskRef,
    });

    await editHandler(req, res);

    expect(mocks.buildBackendUrl).toHaveBeenCalledWith({
      backendHost: 'http://backend.test',
      pathOverride: '/v1/images/edit',
    });
    const [, body] = mocks.postJsonToBackend.mock.calls[0];
    expect(JSON.parse(body)).toEqual({
      prompt: 'Change the label color',
      model: 'gpt-image-2',
      quality: 'high',
      imageRefs,
      maskRef,
      sessionId: 'session-1',
      user: 'alice',
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects blank prompts before calling the backend', async () => {
    const { req, res } = createMockReqRes('POST', {
      prompt: '   ',
      model: 'gpt-image-2',
    });

    await generateHandler(req, res);

    expect(mocks.postJsonToBackend).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Prompt is required' });
  });

  it('rejects edit requests without input images', async () => {
    const { req, res } = createMockReqRes('POST', {
      prompt: 'Change the label color',
      model: 'gpt-image-2',
      imageRefs: [],
    });

    await editHandler(req, res);

    expect(mocks.postJsonToBackend).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Add at least one input image or switch to Generate.',
    });
  });

  it('rejects invalid custom sizes before calling the backend', async () => {
    const { req, res } = createMockReqRes('POST', {
      prompt: 'a product photo',
      model: 'gpt-image-2',
      size: '1000x1000',
    });

    await generateHandler(req, res);

    expect(mocks.postJsonToBackend).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Width and height must be multiples of 16.',
    });
  });

  it('maps backend timeouts to 504', async () => {
    mocks.postJsonToBackend.mockRejectedValueOnce(
      new Error('Backend request timed out after 180000ms'),
    );
    const { req, res } = createMockReqRes('POST', {
      prompt: 'a product photo',
      model: 'gpt-image-2',
    });

    await generateHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Backend timed out' }),
    );
  });

  it('maps backend connection failures to 502', async () => {
    mocks.postJsonToBackend.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:8000'),
    );
    const { req, res } = createMockReqRes('POST', {
      prompt: 'a product photo',
      model: 'gpt-image-2',
    });

    await generateHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Backend unavailable' }),
    );
  });
});
