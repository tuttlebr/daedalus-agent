import handler from '@/pages/api/google-workspace/connections';

import {
  getGoogleWorkspaceConnections,
  resetGoogleWorkspaceConnection,
} from '@/server/googleWorkspaceConnections';
import { requireAuthenticatedUser } from '@/server/session/_utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/googleWorkspaceConnections', () => ({
  getGoogleWorkspaceConnections: vi.fn(),
  resetGoogleWorkspaceConnection: vi.fn(),
}));

vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: vi.fn(),
}));

function createMockReqRes(method: string, query: Record<string, unknown> = {}) {
  const req = { method, query } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
  return { req, res };
}

describe('Google Workspace connections API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuthenticatedUser).mockResolvedValue({
      username: 'alice',
    } as any);
    vi.mocked(getGoogleWorkspaceConnections).mockResolvedValue([]);
    vi.mocked(resetGoogleWorkspaceConnection).mockResolvedValue({
      service: 'docs',
      authorizationCleared: true,
      savedTokenDeleted: true,
      cachedWorkflowsInvalidated: 1,
    });
  });

  it('returns saved authorization state', async () => {
    const connections = [
      {
        id: 'docs' as const,
        label: 'Google Docs',
        description: 'Read documents.',
        authorizationSaved: true,
      },
    ];
    vi.mocked(getGoogleWorkspaceConnections).mockResolvedValue(connections);
    const { req, res } = createMockReqRes('GET');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ connections });
  });

  it('resets one validated service and refreshes its state', async () => {
    const { req, res } = createMockReqRes('DELETE', { service: 'docs' });

    await handler(req, res);

    expect(resetGoogleWorkspaceConnection).toHaveBeenCalledWith(
      'docs',
      'alice',
    );
    expect(getGoogleWorkspaceConnections).toHaveBeenCalledWith('alice');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      reset: expect.objectContaining({ authorizationCleared: true }),
      connections: [],
    });
  });

  it('rejects an unknown service without touching the backend', async () => {
    const { req, res } = createMockReqRes('DELETE', { service: 'drive' });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(resetGoogleWorkspaceConnection).not.toHaveBeenCalled();
  });

  it('surfaces an active-workflow conflict', async () => {
    const conflict = new Error(
      'Wait for the current chat request to finish',
    ) as Error & { status: number };
    conflict.status = 409;
    vi.mocked(resetGoogleWorkspaceConnection).mockRejectedValue(conflict);
    const { req, res } = createMockReqRes('DELETE', { service: 'docs' });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Wait for the current chat request to finish',
    });
  });
});
