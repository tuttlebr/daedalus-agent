// @vitest-environment node
import listHandler from '@/pages/api/api-keys';
import keyHandler from '@/pages/api/api-keys/[keyId]';

import { ApiKeyError } from '@/server/apiKeys';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  rotate: vi.fn(),
  rate: vi.fn(),
}));

vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: mocks.session,
}));
vi.mock('@/server/rateLimit', () => ({
  enforceRateLimit: mocks.rate,
  ruleFromEnv: (name: string) => ({ name, limit: 20, windowSeconds: 3600 }),
}));
vi.mock('@/server/apiKeys', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listApiKeys: mocks.list,
  createApiKey: mocks.create,
  revokeApiKey: mocks.revoke,
  rotateApiKey: mocks.rotate,
}));

function call(method: string, query = {}, body: unknown = {}) {
  const req = { method, query, body } as any;
  const res: any = {
    statusCode: 0,
    body: undefined,
    headers: {} as Record<string, unknown>,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((value: unknown) => {
      res.body = value;
      return res;
    }),
    setHeader: vi.fn((name: string, value: unknown) => {
      res.headers[name] = value;
    }),
  };
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ username: 'alice' });
  mocks.rate.mockResolvedValue(true);
  delete process.env.DAEDALUS_COMPAT_API_ENABLED;
});

describe('API key management routes', () => {
  it('requires a browser session', async () => {
    mocks.session.mockResolvedValue(null);
    const { req, res } = call('GET');
    await listHandler(req, res);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('lists only metadata and reports whether the API is enabled', async () => {
    mocks.list.mockResolvedValue([{ id: 'a', name: 'Laptop' }]);
    process.env.DAEDALUS_COMPAT_API_ENABLED = 'true';
    const { req, res } = call('GET');
    await listHandler(req, res);
    expect(mocks.list).toHaveBeenCalledWith('alice');
    expect(res.body).toEqual({
      enabled: true,
      maxKeys: 10,
      keys: [{ id: 'a', name: 'Laptop' }],
    });
    expect(res.headers['Cache-Control']).toBe('private, no-store');
  });

  it('creates a key for the session user and maps store errors', async () => {
    mocks.create.mockResolvedValue({ key: 'dkey_x', metadata: { id: 'x' } });
    const created = call('POST', {}, { name: 'Laptop', username: 'mallory' });
    await listHandler(created.req, created.res);
    expect(mocks.create).toHaveBeenCalledWith('alice', 'Laptop');
    expect(created.res.statusCode).toBe(201);

    mocks.create.mockRejectedValue(new ApiKeyError('limit_reached', 'Limit'));
    const limited = call('POST', {}, { name: 'Another' });
    await listHandler(limited.req, limited.res);
    expect(limited.res.statusCode).toBe(409);

    mocks.create.mockRejectedValue(new ApiKeyError('invalid_name', 'Bad'));
    const invalid = call('POST', {}, { name: '' });
    await listHandler(invalid.req, invalid.res);
    expect(invalid.res.statusCode).toBe(400);
  });

  it('revokes and rotates only through explicit actions', async () => {
    const revoke = call('DELETE', { keyId: '0123456789abcdef' });
    await keyHandler(revoke.req, revoke.res);
    expect(mocks.revoke).toHaveBeenCalledWith('alice', '0123456789abcdef');
    expect(revoke.res.body).toEqual({ revoked: true });

    mocks.rotate.mockResolvedValue({ key: 'dkey_y', metadata: { id: 'y' } });
    const rotate = call(
      'POST',
      { keyId: '0123456789abcdef' },
      { action: 'rotate' },
    );
    await keyHandler(rotate.req, rotate.res);
    expect(mocks.rotate).toHaveBeenCalledWith('alice', '0123456789abcdef');

    const unknown = call(
      'POST',
      { keyId: '0123456789abcdef' },
      { action: 'x' },
    );
    await keyHandler(unknown.req, unknown.res);
    expect(unknown.res.statusCode).toBe(400);

    mocks.revoke.mockRejectedValue(new ApiKeyError('not_found', 'Missing'));
    const missing = call('DELETE', { keyId: 'ffffffffffffffff' });
    await keyHandler(missing.req, missing.res);
    expect(missing.res.statusCode).toBe(404);
  });

  it('rate limits key changes', async () => {
    mocks.rate.mockResolvedValue(false);
    const { req, res } = call('POST', {}, { name: 'Laptop' });
    await listHandler(req, res);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
