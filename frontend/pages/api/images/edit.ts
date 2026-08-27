import { NextApiRequest, NextApiResponse } from 'next';

import { isBackendUnavailable, removeUnsafeBrowserKeys } from '@/server/images/requestHelpers';

import { buildBackendUrl, getBackendHost } from '@/utils/app/backendApi';
import {
  cleanImageParamsForModel,
  removeImageParamKeys,
  resolveImageModel,
  validateImageParamsForSubmit,
} from '@/utils/app/imageModelCapabilities';
import {
  resolveTimezoneFromHeaders,
  withInternalBackendAuth,
  withTimezoneHeader,
} from '@/utils/server/backendAuth';
import { proxyJsonToBackend } from '@/utils/server/httpProxy';

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
  // Keep a small persistence/response margin beyond the backend provider
  // timeout; nginx grants /api/images/ 360 seconds.
  maxDuration: 360,
};

const EDIT_TIMEOUT_MS = 330_000;
const STREAM_PARTIAL_IMAGES = 2;



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
      pathOverride: '/v1/images/edit',
    });

    const body = typeof req.body === 'object' && req.body ? req.body : {};
    const safeBody = removeUnsafeBrowserKeys(body as Record<string, unknown>);
    const model = resolveImageModel(safeBody.model);
    const prompt = safeBody.prompt;
    const imageRefs = safeBody.imageRefs;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    if (!Array.isArray(imageRefs) || imageRefs.length === 0) {
      return res.status(400).json({
        error: 'Add at least one input image or switch to Generate.',
      });
    }
    const paramsValidation = validateImageParamsForSubmit(safeBody, model);
    if (!paramsValidation.valid) {
      return res
        .status(400)
        .json({ error: paramsValidation.reason ?? 'Invalid image size' });
    }
    const payload = {
      ...removeImageParamKeys(safeBody),
      ...cleanImageParamsForModel(safeBody, model, 'edit'),
      prompt: prompt.trim(),
      model,
      sessionId,
      user: userId,
    };
    if ((payload.n ?? 1) === 1) {
      Object.assign(payload, {
        stream: true,
        partial_images: STREAM_PARTIAL_IMAGES,
      });
    }

    await proxyJsonToBackend(
      backendUrl,
      JSON.stringify(payload),
      withInternalBackendAuth(
        withTimezoneHeader(
          {
            'Content-Type': 'application/json',
            'x-user-id': userId,
            'x-session-id': sessionId,
          },
          resolveTimezoneFromHeaders(req.headers),
        ),
      ),
      EDIT_TIMEOUT_MS,
      res,
    );
    return;
  } catch (error) {
    console.error('images/edit proxy error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const isTimeout =
      message.includes('timed out') || message.includes('ETIMEDOUT');
    const backendUnavailable = isBackendUnavailable(message);
    if (isTimeout) {
      return res.status(504).json({ error: 'Backend timed out', message });
    }
    if (backendUnavailable) {
      return res.status(502).json({ error: 'Backend unavailable', message });
    }
    return res.status(500).json({ error: 'Internal server error', message });
  }
}
