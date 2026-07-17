import { NextApiRequest, NextApiResponse } from 'next';

import { validateMagicBytes } from '@/utils/app/magicBytes';

import { maxBase64EncodedLength } from '@/constants/uploadLimits';
import { positiveIntegerFromEnv } from '@/server/config/env';
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
import crypto from 'crypto';

const DOCUMENT_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MB = 1024 * 1024;
// Next.js requires the body-parser ceiling to be a build-time literal. Clamp
// the runtime raw limit to the largest value the 268 MiB encoded ceiling can
// actually accept; lower operator values still tighten exact post-parse checks.
const DOCUMENT_UPLOAD_MAX_MB = Math.min(
  positiveIntegerFromEnv('DOCUMENT_UPLOAD_MAX_MB', 200),
  200,
);
export const DOCUMENT_UPLOAD_MAX_BYTES = DOCUMENT_UPLOAD_MAX_MB * MB;
export const DOCUMENT_UPLOAD_MAX_BASE64_CHARS = maxBase64EncodedLength(
  DOCUMENT_UPLOAD_MAX_BYTES,
);
// A data-URL header plus filename, MIME type, and JSON syntax should only need
// a few KiB. Keep bounded headroom without restoring the former fixed 300 MiB
// parser limit.
export const DOCUMENT_UPLOAD_BODY_LIMIT_BYTES =
  DOCUMENT_UPLOAD_MAX_BASE64_CHARS + 64 * 1024;
const DOCUMENT_UPLOAD_MAX_CONCURRENT_PER_USER = positiveIntegerFromEnv(
  'DOCUMENT_UPLOAD_MAX_CONCURRENT_PER_USER',
  2,
);
const DOCUMENT_UPLOAD_SLOT_TTL_SECONDS = 15 * 60;
const MAX_DATA_URL_HEADER_CHARS = 256;
const MAX_FILENAME_CHARS = 512;
const MAX_MIME_TYPE_CHARS = 255;
const MAGIC_PREFIX_BYTES = 1024;
const DOCUMENT_SIZE_ERROR = 'Document size exceeds maximum allowed size';
const DOCUMENT_TYPE_ERROR = 'File content does not match claimed MIME type';
const DOCUMENT_DATA_ERROR = 'Document data is not valid base64';

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
  data: string;
  mimeType: string;
  filename: string;
  size: number;
  createdAt: number;
  sessionId: string;
  userId?: string;
}

// Generate a unique ID for the document
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

function extractBase64Payload(base64Data: string): string {
  // Check the total encoded value before slicing a data URL. This prevents an
  // attacker from hiding an unbounded metadata prefix ahead of a small payload.
  if (
    base64Data.length >
    DOCUMENT_UPLOAD_MAX_BASE64_CHARS + MAX_DATA_URL_HEADER_CHARS
  ) {
    throw new Error(DOCUMENT_SIZE_ERROR);
  }

  if (!base64Data.startsWith('data:')) return base64Data;

  const separator = base64Data.indexOf(',');
  if (
    separator < 0 ||
    separator > MAX_DATA_URL_HEADER_CHARS ||
    !base64Data.slice(0, separator).toLowerCase().endsWith(';base64')
  ) {
    throw new Error(DOCUMENT_DATA_ERROR);
  }
  return base64Data.slice(separator + 1);
}

/** Calculate decoded bytes exactly, rejecting malformed base64 without decoding. */
export function decodedBase64Size(encoded: string): number {
  if (!encoded || encoded.length % 4 === 1) {
    throw new Error(DOCUMENT_DATA_ERROR);
  }
  if (encoded.length > DOCUMENT_UPLOAD_MAX_BASE64_CHARS) {
    throw new Error(DOCUMENT_SIZE_ERROR);
  }

  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if (
    (padding > 0 && encoded.length % 4 !== 0) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new Error(DOCUMENT_DATA_ERROR);
  }

  return Math.floor((encoded.length * 3) / 4) - padding;
}

export function inspectDocumentPayload(
  base64Data: string,
  mimeType: string,
): { cleanBase64: string; size: number } {
  const cleanBase64 = extractBase64Payload(base64Data);
  const size = decodedBase64Size(cleanBase64);
  if (size > DOCUMENT_UPLOAD_MAX_BYTES) {
    throw new Error(DOCUMENT_SIZE_ERROR);
  }

  // The validation rules inspect at most the first 1 KiB. Decoding the entire
  // document here used to retain a second 200 MiB allocation until Redis JSON
  // serialization completed.
  const signatureChars = Math.ceil((MAGIC_PREFIX_BYTES * 4) / 3);
  const signature = Buffer.from(cleanBase64.slice(0, signatureChars), 'base64');
  if (!validateMagicBytes(signature, mimeType)) {
    throw new Error(DOCUMENT_TYPE_ERROR);
  }

  return { cleanBase64, size };
}

// Store document in Redis
export async function storeDocument(
  sessionId: string,
  userId: string | undefined,
  base64Data: string,
  filename: string,
  mimeType: string = 'application/octet-stream',
): Promise<string> {
  const { cleanBase64, size } = inspectDocumentPayload(base64Data, mimeType);
  const redis = getRedis();
  const documentId = generateDocumentId();

  const documentData: StoredDocument = {
    id: documentId,
    data: cleanBase64,
    mimeType,
    filename,
    size,
    createdAt: Date.now(),
    sessionId,
    userId,
  };

  const key = sessionKey(['document', sessionId, documentId]);
  await jsonSetWithExpiry(key, documentData, DOCUMENT_EXPIRY_SECONDS);

  // Also store a reference in a session-specific set for easy cleanup
  const sessionDocumentsKey = sessionKey(['session-documents', sessionId]);
  await redis.sadd(sessionDocumentsKey, documentId);
  await redis.expire(sessionDocumentsKey, DOCUMENT_EXPIRY_SECONDS);

  return documentId;
}

// Retrieve document from Redis
export async function getDocument(
  sessionId: string,
  documentId: string,
): Promise<StoredDocument | null> {
  const key = sessionKey(['document', sessionId, documentId]);
  const data = await jsonGet(key);
  return data as StoredDocument | null;
}

// Delete a specific document
export async function deleteDocument(
  sessionId: string,
  documentId: string,
): Promise<boolean> {
  const redis = getRedis();
  const key = sessionKey(['document', sessionId, documentId]);

  // Remove from Redis
  const deleted = await jsonDel(key);

  // Remove from session set
  if (deleted > 0) {
    const sessionDocumentsKey = sessionKey(['session-documents', sessionId]);
    await redis.srem(sessionDocumentsKey, documentId);
  }

  return deleted > 0;
}

// Clean up all documents for a session
export async function cleanupSessionDocuments(
  sessionId: string,
): Promise<number> {
  const redis = getRedis();
  const sessionDocumentsKey = sessionKey(['session-documents', sessionId]);

  // Get all document IDs for this session
  const documentIds = await redis.smembers(sessionDocumentsKey);

  let deletedCount = 0;
  for (const documentId of documentIds) {
    const key = sessionKey(['document', sessionId, documentId]);
    const deleted = await jsonDel(key);
    if (deleted > 0) {
      deletedCount++;
    }
  }

  // Clean up the set itself
  await redis.del(sessionDocumentsKey);

  return deletedCount;
}

// Generous backstop above legitimate batch uploads (batch max ~500 docs);
// caps runaway/abusive upload floods.
const DOC_UPLOAD_RATE_LIMIT = ruleFromEnv(
  'document-upload',
  'RATE_LIMIT_DOC_UPLOAD',
  600,
  60,
);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  const sessionId = getOrSetSessionId(req, res);
  const userId = session.username;

  if (req.method === 'POST') {
    if (!(await enforceRateLimit(res, DOC_UPLOAD_RATE_LIMIT, userId))) return;
    // Store document
    let uploadSlotAcquired = false;
    try {
      const { base64Data, filename, mimeType } = req.body;

      if (typeof base64Data !== 'string' || !base64Data) {
        return res.status(400).json({ error: 'No document data provided' });
      }

      if (typeof filename !== 'string' || !filename) {
        return res.status(400).json({ error: 'No filename provided' });
      }
      if (filename.length > MAX_FILENAME_CHARS) {
        return res.status(400).json({ error: 'Filename is too long' });
      }
      if (
        mimeType !== undefined &&
        (typeof mimeType !== 'string' || mimeType.length > MAX_MIME_TYPE_CHARS)
      ) {
        return res.status(400).json({ error: 'Invalid MIME type' });
      }

      // Avoid JSON serialization and signature decoding for clearly oversized
      // payloads, then reserve a bounded per-user upload slot atomically.
      if (
        base64Data.length >
        DOCUMENT_UPLOAD_MAX_BASE64_CHARS + MAX_DATA_URL_HEADER_CHARS
      ) {
        throw new Error(DOCUMENT_SIZE_ERROR);
      }
      uploadSlotAcquired = await acquireUploadSlot(userId);
      if (!uploadSlotAcquired) {
        res.setHeader('Retry-After', '5');
        return res.status(429).json({
          error: 'Too many document uploads are already in progress',
        });
      }

      const documentId = await storeDocument(
        sessionId,
        userId,
        base64Data,
        filename,
        mimeType,
      );

      return res.status(200).json({ documentId, sessionId, userId });
    } catch (error) {
      console.error('Error storing document:', error);
      const message =
        error instanceof Error ? error.message : 'Failed to store document';
      const status = message.includes(DOCUMENT_SIZE_ERROR)
        ? 413
        : message.includes(DOCUMENT_TYPE_ERROR)
        ? 415
        : message.includes(DOCUMENT_DATA_ERROR)
        ? 400
        : 500;
      return res.status(status).json({ error: message });
    } finally {
      if (uploadSlotAcquired) {
        try {
          await releaseUploadSlot(userId);
        } catch (error) {
          console.error('Error releasing document upload slot:', error);
        }
      }
    }
  } else if (req.method === 'GET') {
    // Retrieve document
    const { documentId, sessionId: querySessionId } = req.query;

    if (!documentId || typeof documentId !== 'string') {
      return res.status(400).json({ error: 'Invalid document ID' });
    }

    // Allow retrieving documents from other sessions (for cross-device persistence)
    const targetSessionId =
      typeof querySessionId === 'string' && querySessionId
        ? querySessionId
        : sessionId;

    try {
      const document = await getDocument(targetSessionId, documentId);

      if (!document) {
        return res.status(404).json({ error: 'Document not found' });
      }

      if (!canAccessStoredDocument(document, sessionId, userId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      // Return document data
      res.setHeader('Content-Type', document.mimeType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${document.filename}"`,
      );
      res.setHeader('Cache-Control', 'private, max-age=3600');

      const buffer = Buffer.from(document.data, 'base64');
      return res.status(200).send(buffer);
    } catch (error) {
      console.error('Error retrieving document:', error);
      return res.status(500).json({ error: 'Failed to retrieve document' });
    }
  } else if (req.method === 'DELETE') {
    // Delete document
    const { documentId } = req.query;

    if (!documentId || typeof documentId !== 'string') {
      return res.status(400).json({ error: 'Invalid document ID' });
    }

    try {
      const deleted = await deleteDocument(sessionId, documentId);

      if (!deleted) {
        return res.status(404).json({ error: 'Document not found' });
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error deleting document:', error);
      return res.status(500).json({ error: 'Failed to delete document' });
    }
  }

  res.setHeader('Allow', ['POST', 'GET', 'DELETE']);
  return res.status(405).json({ error: 'Method not allowed' });
}

// Next.js statically extracts this value at build time, so it must remain a
// literal. 268 MiB is the smallest whole-MiB ceiling that accommodates the
// default 200 MiB raw limit after base64 encoding and bounded JSON overhead.
// storeDocument still enforces DOCUMENT_UPLOAD_MAX_MB exactly.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '268mb',
    },
  },
};

export function canAccessStoredDocument(
  document: StoredDocument,
  currentSessionId: string,
  currentUserId: string,
): boolean {
  if (document.userId) {
    return document.userId === currentUserId;
  }
  return document.sessionId === currentSessionId;
}
