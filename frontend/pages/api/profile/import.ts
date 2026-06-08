import type { NextApiRequest, NextApiResponse } from 'next';

import {
  buildBackendBaseUrlForMode,
  buildBackendUrlFromBase,
} from '@/utils/app/backendApi';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout';

import { buildNatRequestHeaders } from '@/server/chat/natMessages';
import { requireAuthenticatedUser } from '@/server/session/_utils';

const PROFILE_IMPORT_TIMEOUT_MS = 60_000;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
};

function parseBackendPayload(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end('Method Not Allowed');
  }

  const backendUrl = buildBackendUrlFromBase(
    buildBackendBaseUrlForMode(),
    '/v1/profile/import',
  );

  try {
    const response = await fetchWithTimeout(
      backendUrl,
      {
        method: 'POST',
        headers: buildNatRequestHeaders(session.username, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(req.body || {}),
      },
      PROFILE_IMPORT_TIMEOUT_MS,
    );
    const payload = parseBackendPayload(await response.text());
    return res.status(response.status).json(payload);
  } catch (error: any) {
    return res.status(502).json({
      error: `Profile import backend request failed: ${
        error?.message || 'unknown error'
      }`,
    });
  }
}
