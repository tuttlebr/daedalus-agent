import type { NextApiRequest, NextApiResponse } from 'next';

import { enqueueRun, listRuns, QueueFullError } from '@/server/autonomy/store';
import { enforceRateLimit, ruleFromEnv } from '@/server/rateLimit';
import { requireAuthenticatedUser } from '@/server/session/_utils';

const AUTONOMY_RUN_RATE_LIMIT = ruleFromEnv(
  'autonomy-run',
  'RATE_LIMIT_AUTONOMY_RUN',
  30,
  60,
);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  const userId = session.username;

  if (req.method === 'GET') {
    return res.status(200).json(await listRuns(userId));
  }

  if (req.method === 'POST') {
    if (!(await enforceRateLimit(res, AUTONOMY_RUN_RATE_LIMIT, userId))) return;
    try {
      return res
        .status(202)
        .json(
          await enqueueRun(userId, req.body || {}, { enforceDepthCap: true }),
        );
    } catch (error) {
      if (error instanceof QueueFullError) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: error.message });
      }
      throw error;
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).end('Method Not Allowed');
}
