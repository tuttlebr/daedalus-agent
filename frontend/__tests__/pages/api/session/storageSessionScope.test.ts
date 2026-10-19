import { Readable } from 'node:stream';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The sid cookie authenticates auth-session:<sid>. Upload scopes are returned
// to the browser, embedded in model-visible references and written into Redis
// and object-store keys, so none of them may carry the credential itself.
const SID = 'c0ffee00-1111-4222-8333-944444444444';

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  expire: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  putDocumentObject: vi.fn(),
  sadd: vi.fn(),
}));

vi.mock('@/server/session/_utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/session/_utils')>()),
  requireAuthenticatedUser: async () => ({ username: 'alice' }),
}));
vi.mock('@/server/session/redis', () => ({
  getRedis: () => ({
    eval: mocks.eval,
    expire: mocks.expire,
    sadd: mocks.sadd,
  }),
  jsonDel: vi.fn(),
  jsonGet: vi.fn().mockResolvedValue(null),
  jsonSetWithExpiry: mocks.jsonSetWithExpiry,
  sessionKey: (parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
}));
vi.mock('@/server/rateLimit', () => ({
  enforceRateLimit: vi.fn().mockResolvedValue(true),
  ruleFromEnv: (name: string) => ({ name, limit: 100, windowSeconds: 60 }),
}));
vi.mock('@/server/documentObjectStore', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@/server/documentObjectStore')
  >();
  const config = {
    endpoint: new URL('http://minio:9000'),
    accessKey: 'access',
    secretKey: 'secret',
    bucket: 'documents',
    region: 'us-east-1',
    prefix: 'documents',
    requestTimeoutMs: 1_000,
  };
  return {
    ...original,
    deleteDocumentObject: vi.fn(),
    getDocumentObjectConfig: () => config,
    putDocumentObject: mocks.putDocumentObject,
  };
});

function response() {
  return {
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
  } as any;
}

function jsonRequest(body: Record<string, unknown>) {
  return {
    method: 'POST',
    query: {},
    body,
    headers: { cookie: `sid=${SID}` },
    connection: {},
    socket: {},
  } as any;
}

function documentRequest() {
  const boundary = 'scope-boundary';
  const file = Buffer.from('plain text document');
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="notes.txt"\r\n' +
        'Content-Type: text/plain\r\n\r\n',
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const req = Readable.from([body]) as any;
  Object.assign(req, {
    method: 'POST',
    query: {},
    headers: {
      cookie: `sid=${SID}`,
      'content-length': String(body.length),
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-document-size': String(file.length),
    },
    connection: {},
    socket: {},
  });
  return req;
}

function everythingPersistedOrReturned(res: any): string {
  return JSON.stringify({
    responses: res.json.mock.calls,
    records: mocks.jsonSetWithExpiry.mock.calls,
    sets: mocks.sadd.mock.calls,
    objects: mocks.putDocumentObject.mock.calls.map(([input]) => ({
      ...input,
      source: undefined,
    })),
  });
}

describe('upload storage scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eval.mockResolvedValue(1);
    mocks.expire.mockResolvedValue(1);
    mocks.jsonSetWithExpiry.mockResolvedValue(undefined);
    mocks.sadd.mockResolvedValue(1);
    mocks.putDocumentObject.mockImplementation(async ({ source }) => {
      for await (const _chunk of source) {
        // Drain so the multipart trailer is validated.
      }
      return { bucket: 'documents' };
    });
  });

  it('never returns or stores the session credential for image uploads', async () => {
    const handler = (await import('@/pages/api/session/imageStorage')).default;
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#808080' },
    })
      .png()
      .toBuffer();
    const upload = () => {
      const res = response();
      return handler(
        jsonRequest({
          base64Data: png.toString('base64'),
          mimeType: 'image/png',
        }),
        res,
      ).then(() => res);
    };

    const first = await upload();
    const second = await upload();

    expect(first.status).toHaveBeenCalledWith(200);
    const scope = first.json.mock.calls[0][0].sessionId;
    expect(scope).toEqual(expect.any(String));
    expect(scope).not.toBe(SID);
    // A stable scope keeps every reference from one browser session together.
    expect(second.json.mock.calls[0][0].sessionId).toBe(scope);
    expect(everythingPersistedOrReturned(first)).not.toContain(SID);
  });

  it('never returns or stores the session credential for video uploads', async () => {
    const handler = (await import('@/pages/api/session/videoStorage')).default;
    const mp4 = Buffer.from('000000186674797069736f6d00000000', 'hex');
    const res = response();

    await handler(
      jsonRequest({
        base64Data: mp4.toString('base64'),
        filename: 'clip.mp4',
        mimeType: 'video/mp4',
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].sessionId).not.toBe(SID);
    expect(everythingPersistedOrReturned(res)).not.toContain(SID);
  });

  it('keeps the session credential out of document references and object keys', async () => {
    const handler = (await import('@/pages/api/session/documentStorage'))
      .default;
    const res = response();

    await handler(documentRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const reference = res.json.mock.calls[0][0];
    expect(reference.sessionId).not.toBe(SID);
    expect(mocks.putDocumentObject.mock.calls[0][0].objectKey).toContain(
      `/${reference.sessionId}/${reference.documentId}`,
    );
    expect(everythingPersistedOrReturned(res)).not.toContain(SID);
  });
});
