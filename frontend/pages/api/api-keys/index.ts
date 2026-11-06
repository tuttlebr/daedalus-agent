import type { NextApiRequest, NextApiResponse } from 'next';

import {
  ApiKeyError,
  MAX_API_KEYS_PER_USER,
  createApiKey,
  listApiKeys,
} from '@/server/apiKeys';
import { isCompatApiEnabled } from '@/server/compat/config';
import { enforceRateLimit, ruleFromEnv } from '@/server/rateLimit';
import { requireAuthenticatedUser } from '@/server/session/_utils';

const API_KEY_CHANGE_RATE_LIMIT = ruleFromEnv(
  'api-key-changes',
  'RATE_LIMIT_API_KEYS',
  20,
  60 * 60,
);

function apiKeyErrorStatus(error: ApiKeyError): number {
  if (error.reason === 'not_found') return 404;
  if (error.reason === 'limit_reached' || error.reason === 'conflict')
    return 409;
  return 400;
}

/**
 * The signed-in user's API keys. Secrets appear only in the creation
 * response; listings carry names, prefixes and timestamps.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (req.method === 'POST') {
      if (
        !(await enforceRateLimit(
          res,
          API_KEY_CHANGE_RATE_LIMIT,
          session.username,
        ))
      )
        return;
      const created = await createApiKey(session.username, req.body?.name);
      return res.status(201).json(created);
    }
    return res.status(200).json({
      enabled: isCompatApiEnabled(),
      maxKeys: MAX_API_KEYS_PER_USER,
      keys: await listApiKeys(session.username),
    });
  } catch (error) {
    if (error instanceof ApiKeyError) {
      return res
        .status(apiKeyErrorStatus(error))
        .json({ error: error.message, reason: error.reason });
    }
    console.error('API key management failed', error);
    return res
      .status(503)
      .json({ error: 'API key management is temporarily unavailable.' });
  }
}
