import type { NextApiRequest, NextApiResponse } from 'next';

import handler from '@/pages/api/autonomy/approvals';

import {
  ApprovalDecisionInProgressError,
  listApprovals,
  updateApproval,
} from '@/server/autonomy/store';
import { requireAuthenticatedUser } from '@/server/session/_utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: vi.fn(),
}));

vi.mock('@/server/autonomy/store', () => {
  class ApprovalDecisionInProgressError extends Error {
    constructor() {
      super('This approval decision is already being processed.');
    }
  }
  return {
    ApprovalDecisionInProgressError,
    listApprovals: vi.fn(),
    updateApproval: vi.fn(),
  };
});

function requestResponse(method: string, body: Record<string, unknown> = {}) {
  const req = { method, body } as NextApiRequest;
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

describe('autonomy approvals API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuthenticatedUser).mockResolvedValue({
      username: 'alice',
    } as Awaited<ReturnType<typeof requireAuthenticatedUser>>);
  });

  it('lists only the authenticated user approvals', async () => {
    const approvals = [{ id: 'approval-1', status: 'pending' }];
    vi.mocked(listApprovals).mockResolvedValue(approvals as any);
    const { req, res } = requestResponse('GET');

    await handler(req, res);

    expect(listApprovals).toHaveBeenCalledWith('alice');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(approvals);
  });

  it('validates and resolves an approval decision', async () => {
    const approval = { id: 'approval-1', status: 'approved' };
    vi.mocked(updateApproval).mockResolvedValue(approval as any);
    const { req, res } = requestResponse('POST', {
      id: 'approval-1',
      decision: 'approved',
    });

    await handler(req, res);

    expect(updateApproval).toHaveBeenCalledWith(
      'alice',
      'approval-1',
      'approved',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(approval);
  });

  it('rejects invalid, missing, concurrent, and unknown decisions', async () => {
    let call = requestResponse('POST', {
      id: 'approval-1',
      decision: 'maybe',
    });
    await handler(call.req, call.res);
    expect(call.res.status).toHaveBeenCalledWith(400);

    vi.mocked(updateApproval).mockRejectedValueOnce(
      new ApprovalDecisionInProgressError(),
    );
    call = requestResponse('POST', {
      id: 'approval-1',
      decision: 'denied',
    });
    await handler(call.req, call.res);
    expect(call.res.status).toHaveBeenCalledWith(409);

    vi.mocked(updateApproval).mockResolvedValueOnce(null);
    call = requestResponse('POST', {
      id: 'missing',
      decision: 'denied',
    });
    await handler(call.req, call.res);
    expect(call.res.status).toHaveBeenCalledWith(404);
  });

  it('advertises supported methods', async () => {
    const { req, res } = requestResponse('DELETE');

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'POST']);
    expect(res.status).toHaveBeenCalledWith(405);
  });
});
