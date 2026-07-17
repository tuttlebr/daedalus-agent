import { NextApiRequest, NextApiResponse } from 'next';

import { getBackendHost, buildBackendUrl } from '@/utils/app/backendApi';
import {
  MilvusCollectionOwnershipError,
  resolveMilvusCollectionTarget,
} from '@/utils/app/milvusCollections';
import { sanitizeForPromptInterpolation } from '@/utils/app/promptSafety';
import {
  resolveTimezoneFromHeaders,
  withInternalBackendAuth,
  withTimezoneHeader,
} from '@/utils/server/backendAuth';

import { postToBackend } from '@/server/backend/postToBackend';
import { getMilvusMetadata } from '@/server/milvusMetadata';
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

    if (!(await enforceRateLimit(res, DOC_PROCESS_RATE_LIMIT, username))) {
      return;
    }

    const { documentRef, documentRefs, filename, collection, mode } = req.body;
    const requestMode: 'ingest' | 'extract' =
      mode === 'extract' ? 'extract' : 'ingest';

    // Support both single documentRef and multiple documentRefs
    let documentsToProcess;
    if (documentRefs && Array.isArray(documentRefs)) {
      documentsToProcess = documentRefs;
    } else if (documentRef && documentRef.documentId && documentRef.sessionId) {
      documentsToProcess = [documentRef];
    } else {
      return res.status(400).json({ error: 'Invalid document reference(s)' });
    }

    if (requestMode === 'extract' && documentsToProcess.length !== 1) {
      return res.status(400).json({
        error: 'Extract mode supports exactly one document at a time.',
      });
    }

    documentsToProcess = await validateDocumentRefsForUser(
      documentsToProcess,
      sessionId,
      username,
    );

    // Extract mode bypasses the agent entirely — the LLM router was
    // paraphrasing the request, corrupting `username` and falling back to
    // op=ingest. Call the typed REST endpoint directly instead.
    if (requestMode === 'extract') {
      const backendHost = getBackendHost();
      const extractUrl = buildBackendUrl({
        backendHost,
        pathOverride: '/v1/documents/extract',
      });
      const extractBody = JSON.stringify({
        documentRef: documentsToProcess[0],
        username,
      });
      const extractResponse = await postToBackend(
        extractUrl,
        extractBody,
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

      if (
        extractResponse.statusCode < 200 ||
        extractResponse.statusCode >= 300
      ) {
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
    }

    // Ingest mode: collection resolution + synthetic chat message as before.
    let collectionMetadata;
    try {
      collectionMetadata = await getMilvusMetadata(username);
    } catch (metadataError) {
      console.error('Collection metadata unavailable:', metadataError);
      return res.status(503).json({
        error: 'Collection metadata is temporarily unavailable.',
        reason: 'collection_metadata_unavailable',
      });
    }
    let collectionTarget;
    try {
      collectionTarget = resolveMilvusCollectionTarget({
        targetCollection:
          typeof collection === 'string' ? collection : undefined,
        username,
        privateCollectionName: collectionMetadata.userCollection.name,
        databaseName: collectionMetadata.databaseName,
        source: 'document.process',
      });
    } catch (resolveError) {
      if (resolveError instanceof MilvusCollectionOwnershipError) {
        console.warn('Rejected cross-tenant collection ingest:', {
          username,
          requestedCollection: resolveError.requestedCollection,
        });
        return res.status(403).json({
          error: 'You do not have access to the target collection.',
          reason: 'collection_forbidden',
        });
      }
      return res.status(400).json({
        error:
          resolveError instanceof Error
            ? resolveError.message
            : 'Invalid collection target.',
        reason: 'collection_scope_mismatch',
      });
    }
    const targetCollection = collectionTarget.collectionName;

    console.info('Processing documents:', {
      mode: requestMode,
      documentCount: documentsToProcess.length,
      username,
      collection: targetCollection,
      collectionScope: collectionTarget.collectionScope,
      provenance: collectionTarget.provenance,
    });

    // Send a message to the chat endpoint that will trigger the ingest op.
    // The filename is untrusted user input embedded in an agent instruction —
    // defang it to reduce prompt-injection surface (F-008).
    const safeFilename = sanitizeForPromptInterpolation(filename) || 'document';
    const messageContent =
      documentsToProcess.length === 1
        ? `Process the document "${safeFilename}" using user_document_tool with operation="ingest", documentRef=${JSON.stringify(
            documentsToProcess[0],
          )}, collection_name="${targetCollection}", collection_scope="${
            collectionTarget.collectionScope
          }", and provenance=${JSON.stringify(
            collectionTarget.provenance,
          )}. Identity comes only from the trusted request context; do not pass username.`
        : `Process ${
            documentsToProcess.length
          } documents using user_document_tool with operation="ingest", documentRefs=${JSON.stringify(
            documentsToProcess,
          )}, collection_name="${targetCollection}", collection_scope="${
            collectionTarget.collectionScope
          }", and provenance=${JSON.stringify(
            collectionTarget.provenance,
          )}. Identity comes only from the trusted request context; do not pass username.`;

    const chatMessage = {
      messages: [
        {
          role: 'user',
          content: messageContent,
        },
      ],
      additionalProps: {
        username: username,
        enableIntermediateSteps: false,
        isDocumentProcessing: true, // Flag to indicate this is a document processing request
      },
    };

    // Document processing uses the default backend with non-streaming /chat endpoint
    const backendHost = getBackendHost();
    const chatUrl = buildBackendUrl({ backendHost, pathOverride: '/chat' });

    const requestBody = JSON.stringify(chatMessage);
    const backendResponse = await postToBackend(
      chatUrl,
      requestBody,
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

    const backendBodyText = backendResponse.body.toString('utf-8');
    if (backendResponse.statusCode < 200 || backendResponse.statusCode >= 300) {
      console.error('Failed to process document via chat:', backendBodyText);
      return res.status(backendResponse.statusCode).json({
        error: 'Failed to process document',
      });
    }

    const fullResponse = backendBodyText;

    const extractTextFromResponse = (raw: string): string => {
      const trimmed = raw.trim();
      if (!trimmed) {
        return '';
      }

      const tryParseJson = (candidate: string) => {
        try {
          return JSON.parse(candidate) as unknown;
        } catch {
          return null;
        }
      };

      const extractFromJson = (parsed: unknown): string => {
        if (!parsed) return '';
        if (typeof parsed === 'string') return parsed;
        if (typeof parsed === 'object' && parsed !== null) {
          const obj = parsed as Record<string, unknown>;
          if (obj.output_text && typeof obj.output_text === 'string')
            return obj.output_text;
          if (Array.isArray(obj.output)) {
            const outputText = obj.output
              .flatMap(
                (item: unknown) =>
                  (item as Record<string, unknown>)?.content || [],
              )
              .map(
                (content: unknown) =>
                  (content as Record<string, unknown>)?.text,
              )
              .filter((text: unknown) => typeof text === 'string')
              .join('');
            if (outputText) return outputText;
          }
          const choices = Array.isArray(obj.choices) ? obj.choices : [];
          const messageContent = (choices[0] as Record<string, unknown>)
            ?.message as Record<string, unknown> | undefined;
          if (
            typeof messageContent?.content === 'string' &&
            (messageContent.content as string).trim()
          ) {
            return messageContent.content as string;
          }
          const deltaContent = choices
            .map(
              (choice: unknown) =>
                (
                  (choice as Record<string, unknown>)?.delta as Record<
                    string,
                    unknown
                  >
                )?.content,
            )
            .filter((text: unknown) => typeof text === 'string')
            .join('');
          return deltaContent;
        }
        return '';
      };

      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const parsed = tryParseJson(trimmed);
        const extracted = extractFromJson(parsed);
        if (extracted) return extracted;
      }

      const sseLines = trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'));

      if (sseLines.length > 0) {
        let combined = '';
        for (const line of sseLines) {
          const payload = line.replace(/^data:\s*/, '');
          if (!payload || payload === '[DONE]') continue;
          const parsed = tryParseJson(payload);
          const extracted = extractFromJson(parsed);
          if (extracted) {
            combined += extracted;
          } else if (payload && payload !== '[DONE]') {
            combined += payload;
          }
        }
        if (combined.trim()) {
          return combined;
        }
      }

      const firstBrace = trimmed.indexOf('{');
      const lastBrace = trimmed.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        const parsed = tryParseJson(trimmed.slice(firstBrace, lastBrace + 1));
        const extracted = extractFromJson(parsed);
        if (extracted) return extracted;
      }

      return trimmed;
    };

    // Try to extract metadata from the response
    let metadata = {
      documentsIndexed: 0,
      extractedPages: 0,
    };

    // Extract number of documents indexed
    const docsMatch = fullResponse.match(/(\d+)\s+documents?\s+indexed/i);
    if (docsMatch) {
      metadata.documentsIndexed = parseInt(docsMatch[1]);
    }

    // Extract number of pages
    const pagesMatch = fullResponse.match(/(\d+)\s+pages?/i);
    if (pagesMatch) {
      metadata.extractedPages = parseInt(pagesMatch[1]);
    }

    const extractedText = extractTextFromResponse(fullResponse);

    try {
      const parsed = JSON.parse(fullResponse);
      if (parsed && typeof parsed === 'object') {
        const errorMessage = (parsed as Record<string, unknown>).error as
          | Record<string, unknown>
          | undefined;
        if (
          typeof errorMessage?.message === 'string' &&
          (errorMessage.message as string).trim()
        ) {
          return res.status(400).json({
            error: 'Document processing failed',
            details: errorMessage.message,
          });
        }
      }
    } catch {
      // Ignore JSON parse errors; extractedText handles non-JSON responses.
    }

    // Check for actual error responses from the backend
    // Only flag as error if the response starts with error indicators (not if they appear in document content)
    const normalizedResponse = extractedText.toLowerCase().trim();
    const errorPrefixes = [
      'error processing document',
      'error accessing document storage',
      'error processing document data',
      'error: document not found',
      'error: invalid document',
      'error: valid username required',
      'error: collection name must',
      'error: retrieved document data is empty',
      'document not found in storage',
      'nvingest processing error',
      'nv-ingest processing error',
      'failed to process document',
    ];

    // Only flag as error if the response STARTS with an error message
    // This prevents false positives from document content containing "error" somewhere
    const hasError =
      errorPrefixes.some((prefix) => normalizedResponse.startsWith(prefix)) ||
      // Also check for Python tracebacks which indicate backend errors
      normalizedResponse.includes('traceback (most recent call last)');

    if (hasError) {
      return res.status(400).json({
        error: 'Document processing failed',
        details: extractedText,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Document processed successfully',
      details: extractedText,
      extracted: extractedText,
      metadata: {
        ...metadata,
        collection: targetCollection,
      },
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
