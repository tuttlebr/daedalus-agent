import type { NextApiRequest, NextApiResponse } from 'next';

import {
  ApprovalDecisionInProgressError,
  listApprovals,
  updateApproval,
} from '@/server/autonomy/store';
import { requireAuthenticatedUser } from '@/server/session/_utils';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  const userId = session.username;

  if (req.method === 'GET') {
    return res.status(200).json(await listApprovals(userId));
  }

  if (req.method === 'POST') {
    const { id, decision } = req.body || {};
    if (!id || !['approved', 'denied'].includes(decision)) {
      return res.status(400).json({ error: 'id and decision are required' });
    }
    let approval;
    try {
      approval = await updateApproval(userId, id, decision);
    } catch (error) {
      if (error instanceof ApprovalDecisionInProgressError) {
        return res.status(409).json({ error: error.message });
      }
      throw error;
    }
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    return res.status(200).json(approval);
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).end('Method Not Allowed');
}
