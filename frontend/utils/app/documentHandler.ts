import { Logger } from '@/utils/logger';

const logger = new Logger('DocumentHandler');

export interface DocumentReference {
  documentId: string;
  sessionId: string;
  filename?: string;
  mimeType?: string;
}

// Upload document to Redis and return reference
export async function uploadDocument(
  base64Data: string,
  filename: string,
  mimeType: string = 'application/octet-stream'
): Promise<DocumentReference> {
  try {
    const response = await fetch('/api/session/documentStorage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ base64Data, filename, mimeType }),
    });

    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      if (contentType.includes('application/json')) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Upload failed (${response.status})`);
      }
      if (response.status === 413) {
        throw new Error(
          `File "${filename}" is too large to upload. Please reduce the file size and try again.`
        );
      }
      throw new Error(`Upload failed with status ${response.status}`);
    }

    if (!contentType.includes('application/json')) {
      throw new Error(
        'Server returned an unexpected response. The file may be too large to process.'
      );
    }

    const { documentId, sessionId } = await response.json();
    return { documentId, sessionId, filename, mimeType };
  } catch (error) {
    logger.error('Error uploading document', error);
    throw error;
  }
}

// Get document URL from reference
export function getDocumentUrl(documentRef: DocumentReference): string {
  return `/api/session/documentStorage?documentId=${documentRef.documentId}&sessionId=${documentRef.sessionId}`;
}
