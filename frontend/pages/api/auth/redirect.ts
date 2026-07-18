import type { NextApiRequest, NextApiResponse } from 'next';

import { buildBackendUrlFromBase } from '@/utils/app/backendApi';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout';

import {
  deleteOAuthCallbackTarget,
  loadOAuthCallbackTarget,
} from '@/server/mcpOAuth';

const OAUTH_CALLBACK_TIMEOUT_MS = 60_000;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function callbackQuery(req: NextApiRequest): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(req.query)) {
    if (Array.isArray(value)) {
      value.forEach((item) => query.append(name, item));
    } else if (typeof value === 'string') {
      query.append(name, value);
    }
  }
  return query.toString();
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).send('Method Not Allowed');
  }

  const state = Array.isArray(req.query.state)
    ? req.query.state[0]
    : req.query.state;
  if (!state) {
    return res
      .status(400)
      .send('Invalid state. Please restart the authentication process.');
  }

  const target = await loadOAuthCallbackTarget(state);
  if (!target) {
    return res
      .status(400)
      .send(
        'Authentication expired. Please restart the authentication process.',
      );
  }

  const query = callbackQuery(req);
  const backendUrl = `${buildBackendUrlFromBase(
    target.backendBaseUrl,
    '/auth/redirect',
  )}?${query}`;
  const host = firstHeader(req.headers['x-forwarded-host']) || req.headers.host;
  const proto = firstHeader(req.headers['x-forwarded-proto']) || 'http';

  try {
    const response = await fetchWithTimeout(
      backendUrl,
      {
        method: 'GET',
        headers: {
          ...(host ? { Host: host, 'X-Forwarded-Host': host } : {}),
          'X-Forwarded-Proto': proto,
          ...(req.headers['x-forwarded-for']
            ? {
                'X-Forwarded-For': firstHeader(req.headers['x-forwarded-for'])!,
              }
            : {}),
        },
      },
      OAUTH_CALLBACK_TIMEOUT_MS,
    );
    const body = await response.text();
    await deleteOAuthCallbackTarget(state);

    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-cache, no-store');
    return res.status(response.status).send(body);
  } catch {
    // Keep the short-lived mapping so a browser refresh can recover from a
    // transient frontend-to-backend network failure.
    return res
      .status(502)
      .send(
        'Authentication callback is temporarily unavailable. Please retry.',
      );
  }
}
