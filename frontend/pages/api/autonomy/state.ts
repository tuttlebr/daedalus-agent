import type { NextApiRequest, NextApiResponse } from 'next';

import { dashboardState } from '@/server/autonomy/presentation';
import {
  cancelAction,
  reviewProposal,
  getState,
  requestResponsibility,
} from '@/server/autonomy/store';
import { enforceRateLimit, ruleFromEnv } from '@/server/rateLimit';
import { requireAuthenticatedUser } from '@/server/session/_utils';

const limit = ruleFromEnv('autonomy-action', 'RATE_LIMIT_AUTONOMY_RUN', 30, 60);
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  if (req.method === 'GET')
    return res
      .status(200)
      .json(dashboardState(await getState(session.username)));
  if (req.method === 'POST') {
    if (!(await enforceRateLimit(res, limit, session.username))) return;
    try {
      if (req.body?.operation === 'run')
        return res.status(202).json({
          id: await requestResponsibility(
            session.username,
            req.body.responsibility,
          ),
        });
      if (req.body?.operation === 'cancel' && typeof req.body.id === 'string')
        return res
          .status(
            (await cancelAction(session.username, req.body.id)) ? 200 : 404,
          )
          .json({});
      if (
        ['dismiss', 'accept'].includes(req.body?.operation) &&
        typeof req.body.id === 'string'
      )
        return res
          .status(
            (await reviewProposal(
              session.username,
              req.body.id,
              req.body.operation === 'accept' ? 'accepted' : 'dismissed',
            ))
              ? 200
              : 404,
          )
          .json({});
      return res.status(400).json({ error: 'Unknown charter operation' });
    } catch {
      return res.status(400).json({
        error:
          'Unable to apply this charter action. Refresh and check its current state.',
      });
    }
  }
  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).json({ error: 'Method not allowed' });
}
