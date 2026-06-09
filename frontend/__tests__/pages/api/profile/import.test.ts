import type { NextApiRequest, NextApiResponse } from 'next';

import { fetchWithTimeout } from '@/utils/fetchWithTimeout';

import handler from '@/pages/api/profile/import';

import { requireAuthenticatedUser } from '@/server/session/_utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: vi.fn(),
}));

vi.mock('@/utils/app/backendApi', () => ({
  buildBackendBaseUrlForMode: vi.fn(() => 'http://backend:8000'),
  buildBackendUrlFromBase: vi.fn(
    (baseUrl: string, path: string) => `${baseUrl}${path}`,
  ),
}));

vi.mock('@/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}));

function createMockReqRes(method: string, body: Record<string, unknown> = {}) {
  const req = { method, body, headers: {} } as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as unknown as NextApiResponse & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
  };
  return { req, res };
}

describe('profile import API handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DAEDALUS_INTERNAL_API_TOKEN = 'internal-secret';
    vi.mocked(requireAuthenticatedUser).mockResolvedValue({
      username: 'tuttlebr',
    } as Awaited<ReturnType<typeof requireAuthenticatedUser>>);
  });

  it('forwards profile JSON to the trusted backend import route', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue({
      status: 200,
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          status: 'success',
          user_id: 'tuttlebr',
          imported: 1,
        }),
      ),
    } as any);
    const payload = {
      profile_version: '2026-06-08',
      mode: 'append',
      entries: [
        {
          label: 'Identity',
          memory: 'The user prefers to be addressed as Brandon.',
          metadata: { category: 'identity' },
          user_id: 'Brandon Tuttle',
        },
      ],
    };
    const { req, res } = createMockReqRes('POST', payload);

    await handler(req, res);

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      'http://backend:8000/v1/profile/import',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'tuttlebr',
          'x-timezone': 'America/New_York',
          'x-daedalus-internal-token': 'internal-secret',
          Cookie: 'nat-session=tuttlebr',
        },
        body: JSON.stringify(payload),
      },
      60000,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'success',
      user_id: 'tuttlebr',
      imported: 1,
    });
  });

  it('returns 405 for non-POST methods', async () => {
    const { req, res } = createMockReqRes('GET');

    await handler(req, res);

    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.end).toHaveBeenCalledWith('Method Not Allowed');
  });

  it('returns 502 when the backend import request fails', async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValue(
      new Error('connection refused'),
    );
    const { req, res } = createMockReqRes('POST', {
      entries: [{ label: 'Identity', memory: 'remember Brandon' }],
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Profile import backend request failed: connection refused',
    });
  });
});
