import {
  canAccessStoredDocument,
  getDocument,
  type StoredDocument,
} from '@/pages/api/session/documentStorage';

import { UPLOAD_LIMITS } from '@/constants/uploadLimits';

const SAFE_REF_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export interface ValidatedDocumentRef {
  documentId: string;
  sessionId: string;
  filename?: string;
  mimeType?: string;
  userId?: string;
}

export class DocumentRefAccessError extends Error {
  status: number;
  reason: string;

  constructor(status: number, message: string, reason: string) {
    super(message);
    this.name = 'DocumentRefAccessError';
    this.status = status;
    this.reason = reason;
  }
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function assertSafeRefId(
  value: unknown,
  field: 'documentId' | 'sessionId',
): string {
  if (typeof value !== 'string' || !SAFE_REF_ID_PATTERN.test(value)) {
    throw new DocumentRefAccessError(
      400,
      `Invalid document reference ${field}.`,
      'document_ref_invalid',
    );
  }
  return value;
}

function normalizeDocumentRef(
  _input: unknown,
  storedDocument: StoredDocument,
): ValidatedDocumentRef {
  const filename = toOptionalString(storedDocument.filename);
  const mimeType = toOptionalString(storedDocument.mimeType);

  return {
    documentId: storedDocument.id,
    sessionId: storedDocument.sessionId,
    ...(filename ? { filename } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(storedDocument.userId ? { userId: storedDocument.userId } : {}),
  };
}

export async function validateDocumentRefsForUser(
  refs: unknown,
  currentSessionId: string,
  currentUserId: string,
): Promise<ValidatedDocumentRef[]> {
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new DocumentRefAccessError(
      400,
      'Invalid document reference(s).',
      'document_ref_invalid',
    );
  }

  if (refs.length > UPLOAD_LIMITS.MAX_DOCUMENTS_PER_BATCH) {
    throw new DocumentRefAccessError(
      413,
      `Too many document references. Maximum is ${UPLOAD_LIMITS.MAX_DOCUMENTS_PER_BATCH}.`,
      'document_ref_limit_exceeded',
    );
  }

  const validated: ValidatedDocumentRef[] = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') {
      throw new DocumentRefAccessError(
        400,
        'Invalid document reference(s).',
        'document_ref_invalid',
      );
    }

    const candidate = ref as Record<string, unknown>;
    const documentId = assertSafeRefId(candidate.documentId, 'documentId');
    const sessionId = assertSafeRefId(candidate.sessionId, 'sessionId');
    const storedDocument = await getDocument(sessionId, documentId);

    if (!storedDocument) {
      throw new DocumentRefAccessError(
        404,
        'Document attachment not found. Please upload it again.',
        'document_ref_not_found',
      );
    }

    if (
      !canAccessStoredDocument(storedDocument, currentSessionId, currentUserId)
    ) {
      throw new DocumentRefAccessError(
        403,
        'You do not have access to one of the document attachments.',
        'document_ref_forbidden',
      );
    }

    validated.push(normalizeDocumentRef(candidate, storedDocument));
  }

  return validated;
}
