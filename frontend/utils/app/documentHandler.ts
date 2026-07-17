import { Logger } from '@/utils/logger';

import {
  UPLOAD_LIMITS,
  base64PayloadLength,
  formatFileSize,
} from '@/constants/uploadLimits';

const logger = new Logger('DocumentHandler');

export interface DocumentReference {
  documentId: string;
  sessionId: string;
  userId?: string;
  filename?: string;
  mimeType?: string;
}

export function assertDocumentEncodedSize(
  base64Data: string,
  filename: string,
  maxEncodedChars: number = UPLOAD_LIMITS.DOCUMENT_SERVER_MAX_BASE64_CHARS,
): void {
  if (base64PayloadLength(base64Data) > maxEncodedChars) {
    throw new Error(
      `File "${filename}" exceeds the server upload limit (${formatFileSize(
        UPLOAD_LIMITS.DOCUMENT_SERVER_LIMIT_BYTES,
      )}).`,
    );
  }
}

// Upload document to Redis and return reference
export async function uploadDocument(
  base64Data: string,
  filename: string,
  mimeType: string = 'application/octet-stream',
  signal?: AbortSignal,
): Promise<DocumentReference> {
  try {
    // Reject oversized values before JSON.stringify creates another full copy.
    // The server repeats this check against its private runtime limit.
    assertDocumentEncodedSize(base64Data, filename);

    const response = await fetch('/api/session/documentStorage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      signal,
      body: JSON.stringify({ base64Data, filename, mimeType }),
    });

    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      if (contentType.includes('application/json')) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || `Upload failed (${response.status})`,
        );
      }
      if (response.status === 413) {
        throw new Error(
          `File "${filename}" is too large to upload. Please reduce the file size and try again.`,
        );
      }
      throw new Error(`Upload failed with status ${response.status}`);
    }

    if (!contentType.includes('application/json')) {
      throw new Error(
        'Server returned an unexpected response. The file may be too large to process.',
      );
    }

    const { documentId, sessionId, userId } = await response.json();
    return { documentId, sessionId, userId, filename, mimeType };
  } catch (error) {
    logger.error('Error uploading document', error);
    throw error;
  }
}
