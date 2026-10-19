import { NextApiRequest, NextApiResponse } from 'next';

import { getBackendHost, buildBackendUrl } from '@/utils/app/backendApi';
import {
  resolveTimezoneFromHeaders,
  withInternalBackendAuth,
  withTimezoneHeader,
} from '@/utils/server/backendAuth';
import { postToBackend } from '@/utils/server/httpProxy';

import { enforceRateLimit, ruleFromEnv } from '@/server/rateLimit';
import {
  getStorageSessionId,
  requireAuthenticatedUser,
} from '@/server/session/_utils';
import {
  DocumentRefAccessError,
  validateDocumentRefsForUser,
} from '@/server/session/documentRefs';

export const config = {
  api: {
    bodyParser: {
      // This endpoint accepts document references only. Uploaded bytes already
      // live in object storage and must never be replayed through JSON.
      sizeLimit: '1mb',
    },
    // Match the 15-minute timeout used by chat.ts and nginx
    responseLimit: false,
    externalResolver: true,
  },
  maxDuration: 900, // 15 minutes — NV-Ingest processing can be slow for large documents
};

const DOCUMENT_PROCESSING_TIMEOUT_MS = 900_000; // 15 minutes

// Generous backstop on the (NV-Ingest-bearing) document processing path; sized
// above legitimate batch ingests but caps runaway/abusive floods.
const DOC_PROCESS_RATE_LIMIT = ruleFromEnv(
  'document-process',
  'RATE_LIMIT_DOC_PROCESS',
  120,
  60,
);

/**
 * Inline document extraction for the chat composer.
 *
 * Ingestion into a knowledge base runs through chat attachments, where the
 * stream worker resolves the authoritative collection and the backend's
 * document tool performs it. This route previously also accepted an ingest
 * mode that posted a synthetic prompt to a NAT-era `/chat` endpoint; neither
 * the Rust nor the Python service registers that endpoint, so it could only
 * fail. It now rejects that mode explicitly instead of probing the backend.
 */
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
    const sessionId = getStorageSessionId(req, res);
    const username = session.username;
    const timezone = resolveTimezoneFromHeaders(req.headers);

    if (!(await enforceRateLimit(res, DOC_PROCESS_RATE_LIMIT, username))) {
      return;
    }

    const { documentRef, documentRefs, filename, mode } = req.body ?? {};
    if (mode !== 'extract') {
      return res.status(400).json({
        error:
          'Only mode "extract" is supported. Ingest documents by attaching them to a chat message.',
        reason: 'unsupported_mode',
      });
    }

    // Support both single documentRef and multiple documentRefs
    let documentsToProcess;
    if (documentRefs && Array.isArray(documentRefs)) {
      documentsToProcess = documentRefs;
    } else if (documentRef && documentRef.documentId && documentRef.sessionId) {
      documentsToProcess = [documentRef];
    } else {
      return res.status(400).json({ error: 'Invalid document reference(s)' });
    }

    if (documentsToProcess.length !== 1) {
      return res.status(400).json({
        error: 'Extract mode supports exactly one document at a time.',
      });
    }

    documentsToProcess = await validateDocumentRefsForUser(
      documentsToProcess,
      sessionId,
      username,
    );

    // Extraction bypasses the agent entirely — the LLM router was
    // paraphrasing the request, corrupting `username` and falling back to
    // op=ingest. Call the typed REST endpoint directly instead.
    const extractUrl = buildBackendUrl({
      backendHost: getBackendHost(),
      pathOverride: '/v1/documents/extract',
    });
    const extractResponse = await postToBackend(
      extractUrl,
      JSON.stringify({
        documentRef: documentsToProcess[0],
        username,
      }),
      withInternalBackendAuth(
        withTimezoneHeader(
          {
            'Content-Type': 'application/json',
            'x-user-id': username,
          },
          timezone,
        ),
      ),
      DOCUMENT_PROCESSING_TIMEOUT_MS,
    );

    const extractBodyText = extractResponse.body.toString('utf-8');
    let extractPayload: Record<string, unknown> = {};
    try {
      extractPayload = JSON.parse(extractBodyText || '{}');
    } catch {
      extractPayload = {};
    }

    if (extractResponse.statusCode < 200 || extractResponse.statusCode >= 300) {
      const detail =
        typeof extractPayload.detail === 'string'
          ? extractPayload.detail
          : extractBodyText || 'Document extraction failed';
      return res.status(extractResponse.statusCode).json({
        error: 'Document extraction failed',
        details: detail,
      });
    }

    return res.status(200).json({
      success: true,
      mode: 'extract',
      markdown:
        typeof extractPayload.markdown === 'string'
          ? extractPayload.markdown
          : '',
      filename:
        typeof extractPayload.filename === 'string'
          ? extractPayload.filename
          : filename || 'document',
      pages:
        typeof extractPayload.pages === 'number' ? extractPayload.pages : 0,
      truncated: extractPayload.truncated === true,
      originalChars:
        typeof extractPayload.original_chars === 'number'
          ? (extractPayload.original_chars as number)
          : 0,
    });
  } catch (error) {
    if (error instanceof DocumentRefAccessError) {
      console.warn('Rejected document processing request:', {
        status: error.status,
        reason: error.reason,
      });
      return res.status(error.status).json({
        error: error.message,
        reason: error.reason,
      });
    }

    console.error('Error processing document:', error);

    const message = error instanceof Error ? error.message : 'Unknown error';
    const isTimeout =
      message.includes('timed out') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ESOCKETTIMEDOUT');
    const isConnRefused = message.includes('ECONNREFUSED');

    if (isTimeout) {
      return res.status(504).json({
        error: 'Document processing timed out',
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
