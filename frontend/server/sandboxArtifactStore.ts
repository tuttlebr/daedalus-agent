import { positiveIntegerFromEnv } from '@/server/config/env';
import {
  buildDocumentObjectKey,
  deleteDocumentObject,
  getDocumentObjectConfig,
  isExpectedDocumentObjectKey,
  putDocumentObject,
} from '@/server/documentObjectStore';
import {
  getRedis,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';
import crypto from 'node:crypto';
import path from 'node:path';

const SANDBOX_SERVICE_MAX_COLLECTED_BYTES = 6_291_456;
const DOCUMENT_EXPIRY_SECONDS = positiveIntegerFromEnv(
  'DOCUMENT_OBJECT_EXPIRY_SECONDS',
  60 * 60 * 24 * 7,
);

export const SANDBOX_ARTIFACT_MAX_BYTES = Math.min(
  positiveIntegerFromEnv(
    'SANDBOX_ARTIFACT_MAX_BYTES',
    SANDBOX_SERVICE_MAX_COLLECTED_BYTES,
  ),
  SANDBOX_SERVICE_MAX_COLLECTED_BYTES,
);

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.text': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.zip': 'application/zip',
};

interface StoredSandboxArtifact {
  id: string;
  storage: 'object-v1';
  objectKey: string;
  objectBucket: string;
  etag?: string;
  mimeType: string;
  filename: string;
  size: number;
  createdAt: number;
  expiresAt: number;
  sessionId: string;
  userId: string;
  source: 'sandbox';
  conversationIdHash: string;
}

export interface PublishedSandboxArtifact {
  version: 1;
  documentId: string;
  sessionId: string;
  filename: string;
  mimeType: string;
  size: number;
  downloadUrl: string;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizedArtifactPath(value: string): string {
  if (
    !value ||
    value.length > 1024 ||
    value.includes('\0') ||
    path.posix.isAbsolute(value)
  ) {
    throw new Error('Sandbox artifact path is invalid');
  }
  const parts = value.split('/');
  if (
    parts.some((part) => !part || part === '.' || part === '..') ||
    path.posix.normalize(value) !== value
  ) {
    throw new Error('Sandbox artifact path is invalid');
  }
  return value;
}

function mimeTypeFor(filename: string): string {
  return (
    MIME_TYPES[path.posix.extname(filename).toLowerCase()] ||
    'application/octet-stream'
  );
}

function artifactRef(
  document: StoredSandboxArtifact,
): PublishedSandboxArtifact {
  const query = new URLSearchParams({
    documentId: document.id,
    sessionId: document.sessionId,
  });
  return {
    version: 1,
    documentId: document.id,
    sessionId: document.sessionId,
    filename: document.filename,
    mimeType: document.mimeType,
    size: document.size,
    downloadUrl: `/api/session/documentStorage?${query.toString()}`,
  };
}

function isMatchingExistingArtifact(
  value: unknown,
  expected: StoredSandboxArtifact,
): value is StoredSandboxArtifact {
  if (!value || typeof value !== 'object') return false;
  const stored = value as Partial<StoredSandboxArtifact>;
  return (
    stored.id === expected.id &&
    stored.storage === 'object-v1' &&
    stored.objectKey === expected.objectKey &&
    stored.objectBucket === expected.objectBucket &&
    stored.mimeType === expected.mimeType &&
    stored.filename === expected.filename &&
    stored.size === expected.size &&
    stored.sessionId === expected.sessionId &&
    stored.userId === expected.userId &&
    stored.source === 'sandbox' &&
    stored.conversationIdHash === expected.conversationIdHash
  );
}

export async function storeSandboxArtifact(input: {
  ownerId: string;
  conversationId: string;
  filePath: string;
  content: Buffer;
}): Promise<PublishedSandboxArtifact> {
  if (!input.ownerId.trim() || !input.conversationId.trim()) {
    throw new Error('Sandbox artifact owner and conversation are required');
  }
  if (
    input.content.length < 1 ||
    input.content.length > SANDBOX_ARTIFACT_MAX_BYTES
  ) {
    throw new Error('Sandbox artifact size is outside the allowed range');
  }

  const filePath = normalizedArtifactPath(input.filePath);
  const filename = path.posix.basename(filePath);
  const conversationIdHash = sha256(input.conversationId);
  const sessionId = `sandbox-${sha256(
    `${input.ownerId}\0${input.conversationId}`,
  ).slice(0, 32)}`;
  const documentId = sha256(
    Buffer.concat([
      Buffer.from(
        `sandbox-artifact-v1\0${input.ownerId}\0${input.conversationId}\0${filePath}\0`,
      ),
      input.content,
    ]),
  ).slice(0, 32);
  const objectConfig = getDocumentObjectConfig();
  const objectKey = buildDocumentObjectKey(
    input.ownerId,
    sessionId,
    documentId,
    objectConfig,
  );
  if (
    !isExpectedDocumentObjectKey(
      objectKey,
      input.ownerId,
      sessionId,
      documentId,
      objectConfig,
    )
  ) {
    throw new Error('Sandbox artifact object key is invalid');
  }

  const createdAt = Date.now();
  const expected: StoredSandboxArtifact = {
    id: documentId,
    storage: 'object-v1',
    objectKey,
    objectBucket: objectConfig.bucket,
    mimeType: mimeTypeFor(filename),
    filename,
    size: input.content.length,
    createdAt,
    expiresAt: createdAt + DOCUMENT_EXPIRY_SECONDS * 1000,
    sessionId,
    userId: input.ownerId,
    source: 'sandbox',
    conversationIdHash,
  };
  const metadataKey = sessionKey(['document', sessionId, documentId]);
  const existing = await jsonGet(metadataKey);
  if (isMatchingExistingArtifact(existing, expected)) {
    return artifactRef(existing);
  }

  const uploaded = await putDocumentObject(
    {
      objectKey,
      contentType: expected.mimeType,
      contentLength: input.content.length,
      expiresAt: expected.expiresAt,
      ownerId: input.ownerId,
      sessionId,
      documentId,
      source: (async function* () {
        yield input.content;
      })(),
    },
    objectConfig,
  );
  const document: StoredSandboxArtifact = {
    ...expected,
    objectBucket: uploaded.bucket,
    ...(uploaded.etag ? { etag: uploaded.etag } : {}),
  };
  const redis = getRedis();
  const sessionDocumentsKey = sessionKey(['session-documents', sessionId]);
  try {
    await redis.sadd(sessionDocumentsKey, documentId);
    await redis.expire(sessionDocumentsKey, DOCUMENT_EXPIRY_SECONDS);
    await jsonSetWithExpiry(metadataKey, document, DOCUMENT_EXPIRY_SECONDS);
  } catch (error) {
    await redis.srem(sessionDocumentsKey, documentId).catch(() => undefined);
    await deleteDocumentObject(objectKey, objectConfig).catch(() => undefined);
    throw error;
  }
  return artifactRef(document);
}
