import type { NextApiRequest, NextApiResponse } from 'next';

import { positiveIntegerFromEnv } from '@/server/config/env';
import {
  buildDocumentObjectKey,
  deleteDocumentObject,
  getDocumentObject,
  getDocumentObjectConfig,
  isExpectedDocumentObjectKey,
  putDocumentObject,
} from '@/server/documentObjectStore';
import {
  MultipartDocumentError,
  parseMultipartDocument,
} from '@/server/multipartDocument';
import { enforceRateLimit, ruleFromEnv } from '@/server/rateLimit';
import {
  getOrSetSessionId,
  requireAuthenticatedUser,
} from '@/server/session/_utils';
import {
  getRedis,
  sessionKey,
  jsonGet,
  jsonDel,
  jsonSetWithExpiry,
} from '@/server/session/redis';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const MB = 1024 * 1024;
const SAFE_REF_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const DOCUMENT_EXPIRY_SECONDS = positiveIntegerFromEnv(
  'DOCUMENT_OBJECT_EXPIRY_SECONDS',
  60 * 60 * 24 * 7,
);
const DOCUMENT_UPLOAD_MAX_MB = Math.min(
  positiveIntegerFromEnv('DOCUMENT_UPLOAD_MAX_MB', 200),
  200,
);
export const DOCUMENT_UPLOAD_MAX_BYTES = DOCUMENT_UPLOAD_MAX_MB * MB;
const DOCUMENT_UPLOAD_MAX_CONCURRENT_PER_USER = positiveIntegerFromEnv(
  'DOCUMENT_UPLOAD_MAX_CONCURRENT_PER_USER',
  2,
);
const DOCUMENT_UPLOAD_SLOT_TTL_SECONDS = 15 * 60;

const ACQUIRE_UPLOAD_SLOT_LUA = [
  "local count = tonumber(redis.call('GET', KEYS[1]) or '0')",
  'if count >= tonumber(ARGV[1]) then return 0 end',
  "count = redis.call('INCR', KEYS[1])",
  "redis.call('EXPIRE', KEYS[1], ARGV[2])",
  'return count',
].join('\n');

const RELEASE_UPLOAD_SLOT_LUA = [
  "local count = tonumber(redis.call('GET', KEYS[1]) or '0')",
  "if count <= 1 then return redis.call('DEL', KEYS[1]) end",
  "return redis.call('DECR', KEYS[1])",
].join('\n');

export interface StoredDocument {
  id: string;
  storage?: 'object-v1';
  objectKey?: string;
  objectBucket?: string;
  etag?: string;
  /** Read-only compatibility for records written before object storage. */
  data?: string;
  mimeType: string;
  filename: string;
  size: number;
  createdAt: number;
  expiresAt?: number;
  sessionId: string;
  userId?: string;
}

function generateDocumentId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function uploadSlotKey(userId: string): string {
  const ownerHash = crypto
    .createHash('sha256')
    .update(userId)
    .digest('hex')
    .slice(0, 32);
  return sessionKey(['document-upload', ownerHash]);
}

async function acquireUploadSlot(userId: string): Promise<boolean> {
  const result = await getRedis().eval(
    ACQUIRE_UPLOAD_SLOT_LUA,
    1,
    uploadSlotKey(userId),
    DOCUMENT_UPLOAD_MAX_CONCURRENT_PER_USER,
    DOCUMENT_UPLOAD_SLOT_TTL_SECONDS,
  );
  return Number(result) > 0;
}

async function releaseUploadSlot(userId: string): Promise<void> {
  await getRedis().eval(RELEASE_UPLOAD_SLOT_LUA, 1, uploadSlotKey(userId));
}

async function storeDocumentMetadata(document: StoredDocument): Promise<void> {
  const redis = getRedis();
  const key = sessionKey(['document', document.sessionId, document.id]);
  const sessionDocumentsKey = sessionKey([
    'session-documents',
    document.sessionId,
  ]);
  try {
    await redis.sadd(sessionDocumentsKey, document.id);
    await redis.expire(sessionDocumentsKey, DOCUMENT_EXPIRY_SECONDS);
    await jsonSetWithExpiry(key, document, DOCUMENT_EXPIRY_SECONDS);
  } catch (error) {
    try {
      await redis.srem(sessionDocumentsKey, document.id);
    } catch (cleanupError) {
      console.error(
        'Failed to remove incomplete document metadata:',
        cleanupError,
      );
    }
    throw error;
  }
}

export async function getDocument(
  sessionId: string,
  documentId: string,
): Promise<StoredDocument | null> {
  const key = sessionKey(['document', sessionId, documentId]);
  return (await jsonGet(key)) as StoredDocument | null;
}

async function deleteDocumentMetadata(
  sessionId: string,
  documentId: string,
): Promise<boolean> {
  const redis = getRedis();
  const key = sessionKey(['document', sessionId, documentId]);
  const deleted = await jsonDel(key);
  if (deleted > 0) {
    await redis.srem(sessionKey(['session-documents', sessionId]), documentId);
  }
  return deleted > 0;
}

function assertObjectRecord(
  document: StoredDocument,
  ownerId: string,
): { objectKey: string; bucket: string } {
  const config = getDocumentObjectConfig();
  if (
    document.storage !== 'object-v1' ||
    !document.objectKey ||
    document.objectBucket !== config.bucket ||
    !isExpectedDocumentObjectKey(
      document.objectKey,
      ownerId,
      document.sessionId,
      document.id,
      config,
    )
  ) {
    throw new Error('Stored document object reference is invalid');
  }
  return { objectKey: document.objectKey, bucket: config.bucket };
}

async function deleteStoredObject(document: StoredDocument): Promise<void> {
  if (document.storage !== 'object-v1') return;
  if (!document.userId) {
    throw new Error('Stored document object is missing its owner');
  }
  const { objectKey } = assertObjectRecord(document, document.userId);
  await deleteDocumentObject(objectKey);
}

export async function cleanupSessionDocuments(
  sessionId: string,
  currentUserId: string,
): Promise<number> {
  const redis = getRedis();
  const sessionDocumentsKey = sessionKey(['session-documents', sessionId]);
  const documentIds = await redis.smembers(sessionDocumentsKey);
  let deletedCount = 0;

  for (const documentId of documentIds) {
    const document = await getDocument(sessionId, documentId);
    if (!document) {
      await redis.srem(sessionDocumentsKey, documentId);
      continue;
    }
    if (!canAccessStoredDocument(document, sessionId, currentUserId)) continue;
    await deleteStoredObject(document);
    if (await deleteDocumentMetadata(sessionId, documentId)) deletedCount++;
  }
  return deletedCount;
}

const DOC_UPLOAD_RATE_LIMIT = ruleFromEnv(
  'document-upload',
  'RATE_LIMIT_DOC_UPLOAD',
  600,
  60,
);

function safeDownloadFilename(filename: string): string {
  const fallback = filename
    .replace(/[\u0000-\u001f\u007f"\\/]/g, '_')
    .slice(0, 200);
  return fallback || 'document';
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function setDownloadHeaders(
  res: NextApiResponse,
  document: StoredDocument,
): void {
  res.setHeader('Content-Type', document.mimeType);
  res.setHeader('Content-Length', String(document.size));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeDownloadFilename(
      document.filename,
    )}"; filename*=UTF-8''${encodeRfc5987(document.filename)}`,
  );
  res.setHeader('Cache-Control', 'private, max-age=3600');
}

function assertRefId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_REF_ID_PATTERN.test(value)) {
    throw new MultipartDocumentError(400, `Invalid ${label}`);
  }
  return value;
}

function statusForUploadError(error: unknown): number {
  if (error instanceof MultipartDocumentError) return error.status;
  const message = error instanceof Error ? error.message : '';
  if (message.includes('not configured')) return 503;
  return 500;
}

async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  sessionId: string,
  userId: string,
) {
  if (!(await enforceRateLimit(res, DOC_UPLOAD_RATE_LIMIT, userId))) return;
  let slotAcquired = false;
  let uploadedObjectKey: string | undefined;
  let metadataStored = false;
  try {
    slotAcquired = await acquireUploadSlot(userId);
    if (!slotAcquired) {
      res.setHeader('Retry-After', '5');
      return res.status(429).json({
        error: 'Too many document uploads are already in progress',
      });
    }

    const objectConfig = getDocumentObjectConfig();
    const parsed = await parseMultipartDocument(req, DOCUMENT_UPLOAD_MAX_BYTES);
    const documentId = generateDocumentId();
    const objectKey = buildDocumentObjectKey(
      userId,
      sessionId,
      documentId,
      objectConfig,
    );
    const createdAt = Date.now();
    const expiresAt = createdAt + DOCUMENT_EXPIRY_SECONDS * 1000;
    const uploaded = await putDocumentObject(
      {
        objectKey,
        contentType: parsed.mimeType,
        contentLength: parsed.size,
        expiresAt,
        ownerId: userId,
        sessionId,
        documentId,
        source: parsed.stream,
      },
      objectConfig,
    );
    uploadedObjectKey = objectKey;

    const document: StoredDocument = {
      id: documentId,
      storage: 'object-v1',
      objectKey,
      objectBucket: uploaded.bucket,
      ...(uploaded.etag ? { etag: uploaded.etag } : {}),
      mimeType: parsed.mimeType,
      filename: parsed.filename,
      size: parsed.size,
      createdAt,
      expiresAt,
      sessionId,
      userId,
    };
    await storeDocumentMetadata(document);
    metadataStored = true;
    return res.status(200).json({
      documentId,
      sessionId,
      userId,
      filename: parsed.filename,
      mimeType: parsed.mimeType,
    });
  } catch (error) {
    if (uploadedObjectKey && !metadataStored) {
      try {
        await deleteDocumentObject(uploadedObjectKey);
      } catch (cleanupError) {
        console.error(
          'Failed to clean up unreferenced document object:',
          cleanupError,
        );
      }
    }
    console.error('Error storing document:', error);
    const status = statusForUploadError(error);
    return res.status(status).json({
      error:
        error instanceof MultipartDocumentError
          ? error.message
          : status === 503
          ? 'Document object storage is unavailable'
          : 'Failed to store document',
    });
  } finally {
    if (slotAcquired) {
      try {
        await releaseUploadSlot(userId);
      } catch (error) {
        console.error('Error releasing document upload slot:', error);
      }
    }
  }
}

async function handleGet(
  req: NextApiRequest,
  res: NextApiResponse,
  currentSessionId: string,
  userId: string,
) {
  const documentId = assertRefId(req.query.documentId, 'document ID');
  const targetSessionId =
    req.query.sessionId === undefined
      ? currentSessionId
      : assertRefId(req.query.sessionId, 'session ID');
  const document = await getDocument(targetSessionId, documentId);
  if (!document) return res.status(404).json({ error: 'Document not found' });
  if (!canAccessStoredDocument(document, currentSessionId, userId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (document.storage === 'object-v1') {
    const { objectKey } = assertObjectRecord(document, userId);
    const object = await getDocumentObject(objectKey);
    if (!object)
      return res.status(404).json({ error: 'Document object not found' });
    const objectLength = Number(object.headers['content-length']);
    if (!Number.isSafeInteger(objectLength) || objectLength !== document.size) {
      object.destroy();
      throw new Error('Document object length does not match its metadata');
    }
    setDownloadHeaders(res, document);
    await pipeline(object, res);
    return;
  }

  if (typeof document.data !== 'string') {
    throw new Error('Stored document has no readable payload');
  }
  const legacy = Buffer.from(document.data, 'base64');
  if (legacy.length !== document.size) {
    throw new Error('Legacy document length does not match its metadata');
  }
  setDownloadHeaders(res, document);
  return res.status(200).send(legacy);
}

async function handleDelete(
  req: NextApiRequest,
  res: NextApiResponse,
  currentSessionId: string,
  userId: string,
) {
  const documentId = assertRefId(req.query.documentId, 'document ID');
  const targetSessionId =
    req.query.sessionId === undefined
      ? currentSessionId
      : assertRefId(req.query.sessionId, 'session ID');
  const document = await getDocument(targetSessionId, documentId);
  if (!document) return res.status(404).json({ error: 'Document not found' });
  if (!canAccessStoredDocument(document, currentSessionId, userId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await deleteStoredObject(document);
  await deleteDocumentMetadata(targetSessionId, documentId);
  return res.status(200).json({ success: true });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  const sessionId = getOrSetSessionId(req, res);
  const userId = session.username;

  try {
    if (req.method === 'POST')
      return await handlePost(req, res, sessionId, userId);
    if (req.method === 'GET')
      return await handleGet(req, res, sessionId, userId);
    if (req.method === 'DELETE') {
      return await handleDelete(req, res, sessionId, userId);
    }
  } catch (error) {
    console.error('Document storage request failed:', error);
    const status = error instanceof MultipartDocumentError ? error.status : 500;
    return res.status(status).json({
      error:
        status === 500
          ? 'Document storage request failed'
          : (error as Error).message,
    });
  }

  res.setHeader('Allow', ['POST', 'GET', 'DELETE']);
  return res.status(405).json({ error: 'Method not allowed' });
}

export const config = {
  api: {
    bodyParser: false,
  },
};

export function canAccessStoredDocument(
  document: StoredDocument,
  currentSessionId: string,
  currentUserId: string,
): boolean {
  if (document.userId) return document.userId === currentUserId;
  return document.sessionId === currentSessionId;
}
