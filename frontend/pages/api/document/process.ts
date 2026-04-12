import { NextApiRequest, NextApiResponse } from 'next';
import http from 'http';
import { getOrSetSessionId, getUserId } from '../session/_utils';
import { getBackendHost, buildBackendUrl } from '@/utils/app/backendApi';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '150mb',
    },
    // Match the 15-minute timeout used by chat.ts and nginx
    responseLimit: false,
    externalResolver: true,
  },
  maxDuration: 900, // 15 minutes — NV-Ingest processing can be slow for large documents
};

const DOCUMENT_PROCESSING_TIMEOUT_MS = 900_000; // 15 minutes

function postToBackend(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || '80',
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 500,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
        res.on('error', reject);
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Backend request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sessionId = getOrSetSessionId(req, res);
    const userId = await getUserId(req, res);
    const username = userId || 'anon';

    const { documentRef, documentRefs, filename, collection } = req.body;

    // Support both single documentRef and multiple documentRefs
    let documentsToProcess;
    if (documentRefs && Array.isArray(documentRefs)) {
      documentsToProcess = documentRefs;
    } else if (documentRef && documentRef.documentId && documentRef.sessionId) {
      documentsToProcess = [documentRef];
    } else {
      return res.status(400).json({ error: 'Invalid document reference(s)' });
    }

    // Use the collection selected by the user, falling back to the username
    const targetCollection = (typeof collection === 'string' && collection) ? collection : username;

    console.log('Processing documents:', {
      documentCount: documentsToProcess.length,
      username,
      collection: targetCollection
    });

    // Send a message to the chat endpoint that will trigger document processing
    const messageContent = documentsToProcess.length === 1
      ? `Process the document "${filename || 'document'}" using nv_ingest_postprocessing_tool with documentRef=${JSON.stringify(documentsToProcess[0])}, username="${username}", and collection_name="${targetCollection}".`
      : `Process ${documentsToProcess.length} documents using nv_ingest_postprocessing_tool with documentRefs=${JSON.stringify(documentsToProcess)}, username="${username}", and collection_name="${targetCollection}".`;

    const chatMessage = {
      messages: [{
        role: 'user',
        content: messageContent
      }],
      additionalProps: {
        username: username,
        enableIntermediateSteps: false,
        isDocumentProcessing: true  // Flag to indicate this is a document processing request
      }
    };

    // Document processing uses the default backend with non-streaming /chat endpoint
    const backendHost = getBackendHost();
    const chatUrl = buildBackendUrl({ backendHost, pathOverride: '/chat' });

    const requestBody = JSON.stringify(chatMessage);
    const backendResponse = await postToBackend(
      chatUrl,
      requestBody,
      {
        'Content-Type': 'application/json',
        'x-user-id': username,
      },
      DOCUMENT_PROCESSING_TIMEOUT_MS,
    );

    if (backendResponse.statusCode < 200 || backendResponse.statusCode >= 300) {
      console.error('Failed to process document via chat:', backendResponse.body);
      return res.status(backendResponse.statusCode).json({
        error: 'Failed to process document',
        details: backendResponse.body,
      });
    }

    const fullResponse = backendResponse.body;

    console.log('Document processing response:', fullResponse);

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
          if (obj.output_text && typeof obj.output_text === 'string') return obj.output_text;
          if (Array.isArray(obj.output)) {
            const outputText = obj.output
              .flatMap((item: unknown) => (item as Record<string, unknown>)?.content || [])
              .map((content: unknown) => (content as Record<string, unknown>)?.text)
              .filter((text: unknown) => typeof text === 'string')
              .join('');
            if (outputText) return outputText;
          }
          const choices = Array.isArray(obj.choices) ? obj.choices : [];
          const messageContent = (choices[0] as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
          if (typeof messageContent?.content === 'string' && (messageContent.content as string).trim()) {
            return messageContent.content as string;
          }
          const deltaContent = choices
            .map((choice: unknown) => ((choice as Record<string, unknown>)?.delta as Record<string, unknown>)?.content)
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
      extractedPages: 0
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
        const errorMessage = (parsed as Record<string, unknown>).error as Record<string, unknown> | undefined;
        if (typeof errorMessage?.message === 'string' && (errorMessage.message as string).trim()) {
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
    const hasError = errorPrefixes.some((prefix) =>
      normalizedResponse.startsWith(prefix),
    ) || (
      // Also check for Python tracebacks which indicate backend errors
      normalizedResponse.includes('traceback (most recent call last)')
    );

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
    console.error('Error processing document:', error);

    const message = error instanceof Error ? error.message : 'Unknown error';
    const isTimeout = message.includes('timed out') || message.includes('ETIMEDOUT') || message.includes('ESOCKETTIMEDOUT');
    const isConnRefused = message.includes('ECONNREFUSED');

    if (isTimeout) {
      return res.status(504).json({
        error: 'Document processing timed out',
        message: 'The backend did not respond within the allowed time. The document may be too large or the backend is under heavy load.',
      });
    }

    if (isConnRefused) {
      return res.status(502).json({
        error: 'Backend unavailable',
        message: 'Could not connect to the backend service. Please verify the backend is running.',
      });
    }

    return res.status(500).json({
      error: 'Internal server error',
      message,
    });
  }
}
