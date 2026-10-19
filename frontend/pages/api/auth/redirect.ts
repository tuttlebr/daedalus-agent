import type { NextApiRequest, NextApiResponse } from 'next';

import { buildBackendUrlFromBase } from '@/utils/app/backendApi';
import { getSession } from '@/utils/auth/session';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout';

import { completeOAuthJobRequest } from '@/server/chat/jobState';
import {
  deleteOAuthCallbackTarget,
  isOAuthCallbackOwner,
  loadOAuthCallbackTarget,
} from '@/server/mcpOAuth';
import { createHash } from 'node:crypto';

const OAUTH_CALLBACK_TIMEOUT_MS = 60_000;
const OAUTH_CALLBACK_CONTENT_TYPE = 'text/html; charset=utf-8';
// Google's callback is a cross-site navigation, so the SameSite=strict session
// cookie is absent from it. The continuation page re-sends the parameters as a
// same-origin POST, which carries the cookie and can be bound to its user.
const CONTINUATION_PATH = '/api/auth/redirect';
const CONTINUATION_FORM_ID = 'oauth-callback';
const CONTINUATION_SCRIPT = `document.getElementById('${CONTINUATION_FORM_ID}').submit();`;
const CONTINUATION_POLICY = [
  "default-src 'none'",
  `script-src 'sha256-${createHash('sha256')
    .update(CONTINUATION_SCRIPT)
    .digest('base64')}'`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');
const CALLBACK_FIELDS = [
  ['state', 512],
  ['code', 4096],
  ['error', 256],
] as const;

type CallbackParams = Partial<
  Record<(typeof CALLBACK_FIELDS)[number][0], string>
>;

function sendHtml(res: NextApiResponse, status: number, body: string) {
  res.setHeader('Content-Type', OAUTH_CALLBACK_CONTENT_TYPE);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  return res.status(status).send(body);
}

function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Only the parameters the backend callback consumes, each bounded. */
function callbackParams(source: unknown): CallbackParams | null {
  const values =
    source && typeof source === 'object'
      ? (source as Record<string, unknown>)
      : {};
  const params: CallbackParams = {};
  for (const [name, maxLength] of CALLBACK_FIELDS) {
    const value = firstValue(values[name]);
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || value.length > maxLength) return null;
    params[name] = value;
  }
  return params;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function continuationPage(params: CallbackParams): string {
  const fields = CALLBACK_FIELDS.flatMap(([name]) =>
    params[name] === undefined
      ? []
      : [
          `<input type="hidden" name="${name}" value="${escapeHtml(
            params[name]!,
          )}">`,
        ],
  ).join('');
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Completing authorization</title></head><body>',
    `<form id="${CONTINUATION_FORM_ID}" method="post" action="${CONTINUATION_PATH}">`,
    fields,
    '<p>Completing authorization for the Daedalus account signed in to this browser.</p>',
    '<button type="submit">Continue</button>',
    '</form>',
    `<script>${CONTINUATION_SCRIPT}</script>`,
    '</body></html>',
  ].join('');
}

async function renderContinuation(
  res: NextApiResponse,
  params: CallbackParams,
) {
  // Validate before rendering so an expired link keeps its existing message.
  if (!(await loadOAuthCallbackTarget(params.state!))) {
    return sendHtml(
      res,
      400,
      'Authentication expired. Please restart the authentication process.',
    );
  }
  res.setHeader('Content-Security-Policy', CONTINUATION_POLICY);
  res.setHeader('Referrer-Policy', 'no-referrer');
  return sendHtml(res, 200, continuationPage(params));
}

async function completeCallback(
  req: NextApiRequest,
  res: NextApiResponse,
  params: CallbackParams,
) {
  const state = params.state!;
  const session = await getSession(req, res);
  if (!session?.username) {
    return sendHtml(
      res,
      401,
      'Sign in to Daedalus in this browser, then restart the authorization from the chat.',
    );
  }

  const target = await loadOAuthCallbackTarget(state);
  if (!target) {
    return sendHtml(
      res,
      400,
      'Authentication expired. Please restart the authentication process.',
    );
  }
  if (!(await isOAuthCallbackOwner(target, session.username))) {
    // Keep the target: the account that started the flow can still finish it.
    return sendHtml(
      res,
      403,
      'This authorization was started by a different Daedalus account. Only that account can complete it.',
    );
  }

  const query = new URLSearchParams(
    CALLBACK_FIELDS.flatMap(([name]) =>
      params[name] === undefined ? [] : [[name, params[name]!]],
    ),
  ).toString();
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
    if (response.ok) {
      // OAuth itself has already succeeded at the backend. UI reconciliation
      // is best effort and must never turn that success into a retryable 502.
      await completeOAuthJobRequest(target.jobId, state).catch(() => false);
    }
    await deleteOAuthCallbackTarget(state);

    const contentType = response.headers.get('content-type');
    res.setHeader('Content-Type', contentType || OAUTH_CALLBACK_CONTENT_TYPE);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    return res.status(response.status).send(body);
  } catch {
    // Keep the short-lived mapping so resubmitting can recover from a
    // transient frontend-to-backend network failure.
    return sendHtml(
      res,
      502,
      'Authentication callback is temporarily unavailable. Please retry.',
    );
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST']);
    return sendHtml(res, 405, 'Method Not Allowed');
  }

  const params = callbackParams(req.method === 'GET' ? req.query : req.body);
  if (!params?.state) {
    return sendHtml(
      res,
      400,
      'Invalid state. Please restart the authentication process.',
    );
  }
  return req.method === 'GET'
    ? renderContinuation(res, params)
    : completeCallback(req, res, params);
}
