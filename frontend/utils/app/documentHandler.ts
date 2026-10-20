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
  if (file.size === 0) {
    throw new Error(
      'The selected document is empty. Please select the file again.',
    );
  }
  if (file.size > maxBytes) {
    throw new Error(
      `File "${file.name}" exceeds the server upload limit (${formatFileSize(
        UPLOAD_LIMITS.DOCUMENT_SERVER_LIMIT_BYTES,
      )}).`,
    );
  }
}

async function readableUploadFile(
  file: File,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const isWebKit =
    /AppleWebKit\//.test(userAgent) &&
    !/(?:Chrome|Chromium|Edg|OPR)\//.test(userAgent);
  if (!isWebKit) return file;

  // WebKit can send disk-backed Files with Content-Length: 0, including on
  // service-worker-controlled pages. Read in the page and upload an in-memory
  // Blob; wrapping the original File alone can retain the broken disk reference.
  // https://bugs.webkit.org/show_bug.cgi?id=319985
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      'Could not read the document. Please select the file again.',
    );
  }
  signal?.throwIfAborted();
  if (bytes.byteLength !== file.size) {
    throw new Error(
      'Could not read the complete document. Please select the file again.',
    );
  }
  return new Blob([bytes], { type: file.type || 'application/octet-stream' });
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
    formData.append('file', await readableUploadFile(file, signal), file.name);

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
