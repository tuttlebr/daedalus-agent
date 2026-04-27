import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisCall = vi.fn();
const redisGet = vi.fn();
const redisSmembers = vi.fn();
const jsonGet = vi.fn();
const getOrSetSessionId = vi.fn();
const getUserId = vi.fn();

vi.mock('@/pages/api/session/redis', () => ({
  getRedis: vi.fn(() => ({
    call: redisCall,
    get: redisGet,
    smembers: redisSmembers,
  })),
  jsonGet,
  sessionKey: vi.fn((parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
  ),
}));

vi.mock('@/pages/api/session/_utils', () => ({
  getOrSetSessionId,
  getUserId,
}));

vi.mock('@/utils/app/imageHandler', () => ({
  extractImageReferences: vi.fn(() => []),
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('thumb')),
  })),
}));

function createMockReqRes(id = 'abc-123') {
  const req = {
    method: 'GET',
    query: { id },
    headers: {},
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
  return { req, res };
}

async function loadHandler(legacyPublic = 'true') {
  vi.resetModules();
  process.env.GENERATED_IMAGE_LEGACY_PUBLIC = legacyPublic;
  return (await import('@/pages/api/generated-image/[id]')).default;
}

describe('/api/generated-image/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrSetSessionId.mockReturnValue('session-1');
    getUserId.mockResolvedValue('testuser');
    redisCall.mockResolvedValue(
      JSON.stringify([
        { data: Buffer.from('full').toString('base64'), mimeType: 'image/png' },
      ]),
    );
    redisGet.mockResolvedValue(null);
    redisSmembers.mockResolvedValue([]);
    jsonGet.mockResolvedValue([]);
  });

  it('serves authorized history images with private cache headers', async () => {
    const handler = await loadHandler('false');
    jsonGet.mockResolvedValueOnce([{ outputImageIds: ['abc-123'] }]);
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, max-age=86400, immutable',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(Buffer.from('full'));
  });

  it('rejects unowned images when legacy public access is disabled', async () => {
    const handler = await loadHandler('false');
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
  });
});
