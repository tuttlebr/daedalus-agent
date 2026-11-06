import type { NextApiRequest, NextApiResponse } from 'next';

import { ApiKeyError, revokeApiKey, rotateApiKey } from '@/server/apiKeys';
import { enforceRateLimit, ruleFromEnv } from '@/server/rateLimit';
import { requireAuthenticatedUser } from '@/server/session/_utils';

const API_KEY_CHANGE_RATE_LIMIT = ruleFromEnv(
  'api-key-changes',
  'RATE_LIMIT_API_KEYS',
  20,
  60 * 60,
);

/**
 * Revoke (DELETE) or rotate (POST `{"action":"rotate"}`) one of the signed-in
 * user's keys. Another user's key is indistinguishable from a missing one.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method !== 'DELETE' && req.method !== 'POST') {
    res.setHeader('Allow', ['DELETE', 'POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const keyId = typeof req.query.keyId === 'string' ? req.query.keyId : '';
  if (req.method === 'POST' && req.body?.action !== 'rotate') {
    return res.status(400).json({ error: 'Unsupported key action' });
  }
  if (
    !(await enforceRateLimit(res, API_KEY_CHANGE_RATE_LIMIT, session.username))
  )
    return;

  try {
    if (req.method === 'DELETE') {
      await revokeApiKey(session.username, keyId);
      return res.status(200).json({ revoked: true });
    }
    return res.status(200).json(await rotateApiKey(session.username, keyId));
  } catch (error) {
    if (error instanceof ApiKeyError) {
      return res
        .status(error.reason === 'not_found' ? 404 : 409)
        .json({ error: error.message, reason: error.reason });
    }
    console.error('API key management failed', error);
    return res
      .status(503)
      .json({ error: 'API key management is temporarily unavailable.' });
  }
}
