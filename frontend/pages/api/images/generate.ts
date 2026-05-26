import { NextApiRequest, NextApiResponse } from 'next';

import { buildBackendUrl, getBackendHost } from '@/utils/app/backendApi';
import { withInternalBackendAuth } from '@/utils/server/backendAuth';
import { postJsonToBackend } from '@/utils/server/httpProxy';

import {
  getOrSetSessionId,
  requireAuthenticatedUser,
} from '@/server/session/_utils';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '5mb',
    },
    responseLimit: false,
    externalResolver: true,
  },
  maxDuration: 300,
};

const GENERATE_TIMEOUT_MS = 180_000;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await requireAuthenticatedUser(req, res);
    if (!session) return;

    const sessionId = getOrSetSessionId(req, res);
    const userId = session.username;

    const backendUrl = buildBackendUrl({
      backendHost: getBackendHost(),
      pathOverride: '/v1/images/generate',
    });

    const payload = {
      ...req.body,
      sessionId,
      user: userId,
    };

    const backendResponse = await postJsonToBackend(
      backendUrl,
      JSON.stringify(payload),
      withInternalBackendAuth({
        'Content-Type': 'application/json',
        'x-user-id': userId,
        'x-session-id': sessionId,
      }),
      GENERATE_TIMEOUT_MS,
    );

    res.status(backendResponse.statusCode);
    try {
      return res.json(JSON.parse(backendResponse.body));
    } catch {
      return res.send(backendResponse.body);
    }
  } catch (error) {
    console.error('images/generate proxy error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const isTimeout =
      message.includes('timed out') || message.includes('ETIMEDOUT');
    const isConnRefused = message.includes('ECONNREFUSED');
    if (isTimeout) {
      return res.status(504).json({ error: 'Backend timed out', message });
    }
    if (isConnRefused) {
      return res.status(502).json({ error: 'Backend unavailable', message });
    }
    return res.status(500).json({ error: 'Internal server error', message });
  }
}
