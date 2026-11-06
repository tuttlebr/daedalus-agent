import type { NextApiRequest, NextApiResponse } from 'next';

import { authenticateCompatRequest } from '@/server/compat/auth';
import { COMPAT_MODEL_ALIAS, isCompatApiEnabled } from '@/server/compat/config';
import { CompatError } from '@/server/compat/errors';
import {
  anthropicErrorBody,
  openAIErrorBody,
} from '@/server/compat/responders';

// A fixed, documented creation time keeps the listing stable across restarts.
const ALIAS_CREATED_AT = '2026-11-06T00:00:00Z';

/**
 * The agent alias in the shape each SDK expects: Anthropic clients send
 * `anthropic-version`, OpenAI clients do not. Only `daedalus` is advertised;
 * it selects the existing automatic model policy.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const anthropic = typeof req.headers['anthropic-version'] === 'string';
  res.setHeader('Cache-Control', 'no-store');
  const fail = (error: CompatError) => {
    const { status, body } = anthropic
      ? anthropicErrorBody(error)
      : openAIErrorBody(error);
    res.setHeader('x-should-retry', error.retryable ? 'true' : 'false');
    res.status(status).json(body);
  };
  if (!isCompatApiEnabled())
    return fail(new CompatError('not_found', 'Not found.'));
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  try {
    await authenticateCompatRequest(req.headers);
  } catch (error) {
    return fail(
      error instanceof CompatError
        ? error
        : new CompatError('api_error', 'Authentication failed.'),
    );
  }
  if (anthropic) {
    return res.status(200).json({
      data: [
        {
          type: 'model',
          id: COMPAT_MODEL_ALIAS,
          display_name: 'Daedalus agent',
          created_at: ALIAS_CREATED_AT,
        },
      ],
      has_more: false,
      first_id: COMPAT_MODEL_ALIAS,
      last_id: COMPAT_MODEL_ALIAS,
    });
  }
  return res.status(200).json({
    object: 'list',
    data: [
      {
        id: COMPAT_MODEL_ALIAS,
        object: 'model',
        created: Math.floor(Date.parse(ALIAS_CREATED_AT) / 1000),
        owned_by: 'daedalus',
      },
    ],
  });
}
