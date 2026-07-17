import { Logger } from '@/utils/logger';

import { UPLOAD_LIMITS, formatFileSize } from '@/constants/uploadLimits';

const logger = new Logger('DocumentHandler');

export interface DocumentReference {
  documentId: string;
  sessionId: string;
  userId?: string;
  filename?: string;
  mimeType?: string;
}

export function assertDocumentFileSize(
  file: Pick<File, 'name' | 'size'>,
  maxBytes: number = UPLOAD_LIMITS.DOCUMENT_SERVER_LIMIT_BYTES,
): void {
  if (file.size > maxBytes) {
    throw new Error(
      `File "${file.name}" exceeds the server upload limit (${formatFileSize(
        UPLOAD_LIMITS.DOCUMENT_SERVER_LIMIT_BYTES,
      )}).`,
    );
  }
}

// Stream a document to owner-scoped object storage and return its reference.
export async function uploadDocument(
  file: File,
  signal?: AbortSignal,
): Promise<DocumentReference> {
  try {
    assertDocumentFileSize(file);
    const mimeType = file.type || 'application/octet-stream';
    const formData = new FormData();
    formData.append('file', file, file.name);

    const response = await fetch('/api/session/documentStorage', {
      method: 'POST',
      headers: {
        'X-Document-Size': String(file.size),
      },
      credentials: 'include',
      signal,
      body: formData,
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
          `File "${file.name}" is too large to upload. Please reduce the file size and try again.`,
        );
      }
      throw new Error(`Upload failed with status ${response.status}`);
    }

    if (!contentType.includes('application/json')) {
      throw new Error(
        'Server returned an unexpected response. The file may be too large to process.',
      );
    }

    const {
      documentId,
      sessionId,
      userId,
      filename: storedFilename,
      mimeType: storedMimeType,
    } = await response.json();
    return {
      documentId,
      sessionId,
      userId,
      filename: storedFilename || file.name,
      mimeType: storedMimeType || mimeType,
    };
  } catch (error) {
    logger.error('Error uploading document', error);
    throw error;
  }
}
