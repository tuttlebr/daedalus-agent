import { NextApiRequest, NextApiResponse } from 'next';

import { buildBackendUrl, getBackendHost } from '@/utils/app/backendApi';
import {
  resolveTimezoneFromHeaders,
  withInternalBackendAuth,
  withTimezoneHeader,
} from '@/utils/server/backendAuth';

import { postToBackend } from '@/server/backend/postToBackend';
import { enforceRateLimit, ruleFromEnv } from '@/server/rateLimit';
import {
  getOrSetSessionId,
  requireAuthenticatedUser,
} from '@/server/session/_utils';
import {
  DocumentRefAccessError,
  validateDocumentRefsForUser,
} from '@/server/session/documentRefs';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
    // The request is tiny, but the response (full-document markdown) can be
    // large and NV-Ingest extraction is slow — disable the response cap and
    // match the 15-minute timeout used by the rest of the document path.
    responseLimit: false,
    externalResolver: true,
  },
  maxDuration: 900,
};

const DOCUMENT_MARKDOWN_TIMEOUT_MS = 900_000; // 15 minutes

// Conversion runs NV-Ingest, so keep a generous-but-bounded backstop.
const DOC_MARKDOWN_RATE_LIMIT = ruleFromEnv(
  'document-markdown',
  'RATE_LIMIT_DOC_MARKDOWN',
  60,
  60,
);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await requireAuthenticatedUser(req, res);
    if (!session) return;
    const sessionId = getOrSetSessionId(req, res);
    const username = session.username;
    const timezone = resolveTimezoneFromHeaders(req.headers);

    if (!(await enforceRateLimit(res, DOC_MARKDOWN_RATE_LIMIT, username))) {
      return;
    }

    const { documentRef } = req.body ?? {};
    if (!documentRef || !documentRef.documentId || !documentRef.sessionId) {
      return res.status(400).json({ error: 'Invalid document reference' });
    }

    const [validatedRef] = await validateDocumentRefsForUser(
      [documentRef],
      sessionId,
      username,
    );

    const backendHost = getBackendHost();
    const markdownUrl = buildBackendUrl({
      backendHost,
      pathOverride: '/v1/documents/markdown',
    });
    const backendResponse = await postToBackend(
      markdownUrl,
      JSON.stringify({ documentRef: validatedRef, username }),
      withInternalBackendAuth(
        withTimezoneHeader(
          {
            'Content-Type': 'application/json',
            'x-user-id': username,
          },
          timezone,
        ),
      ),
      DOCUMENT_MARKDOWN_TIMEOUT_MS,
    );

    if (backendResponse.statusCode < 200 || backendResponse.statusCode >= 300) {
      let detail = backendResponse.body.toString('utf-8');
      try {
        const parsed = JSON.parse(detail);
        if (parsed && typeof parsed.detail === 'string') {
          detail = parsed.detail;
        }
      } catch {
        // Non-JSON error body; surface as-is.
      }
      return res.status(backendResponse.statusCode).json({
        error: 'Document conversion failed',
        details: detail || 'Document conversion failed',
      });
    }

    const contentDisposition =
      typeof backendResponse.headers['content-disposition'] === 'string'
        ? (backendResponse.headers['content-disposition'] as string)
        : 'attachment; filename="document.md"';
    const truncated = backendResponse.headers['x-document-truncated'];

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', contentDisposition);
    res.setHeader('Cache-Control', 'private, no-store');
    if (typeof truncated === 'string') {
      res.setHeader('X-Document-Truncated', truncated);
    }
    return res.status(200).send(backendResponse.body);
  } catch (error) {
    if (error instanceof DocumentRefAccessError) {
      console.warn('Rejected document markdown request:', {
        status: error.status,
        reason: error.reason,
      });
      return res.status(error.status).json({
        error: error.message,
        reason: error.reason,
      });
    }

    console.error('Error converting document to markdown:', error);

    const message = error instanceof Error ? error.message : 'Unknown error';
    const isTimeout =
      message.includes('timed out') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ESOCKETTIMEDOUT');
    const isConnRefused = message.includes('ECONNREFUSED');

    if (isTimeout) {
      return res.status(504).json({
        error: 'Document conversion timed out',
        message:
          'The backend did not respond within the allowed time. The document may be too large or the backend is under heavy load.',
      });
    }

    if (isConnRefused) {
      return res.status(502).json({
        error: 'Backend unavailable',
        message:
          'Could not connect to the backend service. Please verify the backend is running.',
      });
    }

    return res.status(500).json({
      error: 'Internal server error',
    });
  }
}
