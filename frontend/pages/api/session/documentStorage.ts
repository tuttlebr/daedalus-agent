import { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey, jsonGet, jsonDel, jsonSetWithExpiry } from './redis';
import { getUserId, getOrSetSessionId } from './_utils';
import { validateMagicBytes } from '@/utils/app/magicBytes';
import crypto from 'crypto';

const DOCUMENT_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_DOCUMENT_SIZE = 100 * 1024 * 1024; // 100MB limit (matches SERVER_DOCUMENT_LIMIT in uploadLimits.ts)

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

// Store document in Redis
export async function storeDocument(
  sessionId: string,
  userId: string | undefined,
  base64Data: string,
  filename: string,
  mimeType: string = 'application/octet-stream'
): Promise<string> {
  const redis = getRedis();
  const documentId = generateDocumentId();

  // Remove data URL prefix if present
  const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');
  const size = buffer.length;

  if (size > MAX_DOCUMENT_SIZE) {
    throw new Error('Document size exceeds maximum allowed size');
  }

  // Validate magic bytes match claimed MIME type
  if (!validateMagicBytes(buffer, mimeType)) {
    throw new Error('File content does not match claimed MIME type');
  }

  const documentData: StoredDocument = {
    id: documentId,
    data: cleanBase64,
    mimeType,
    filename,
    size,
    createdAt: Date.now(),
    sessionId,
    userId
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
  documentId: string
): Promise<StoredDocument | null> {
  const key = sessionKey(['document', sessionId, documentId]);
  const data = await jsonGet(key);
  return data as StoredDocument | null;
}

// Delete a specific document
export async function deleteDocument(
  sessionId: string,
  documentId: string
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
export async function cleanupSessionDocuments(sessionId: string): Promise<number> {
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const sessionId = getOrSetSessionId(req, res);
  const userId = await getUserId(req, res);

  if (req.method === 'POST') {
    // Store document
    try {
      const { base64Data, filename, mimeType } = req.body;

      if (!base64Data) {
        return res.status(400).json({ error: 'No document data provided' });
      }

      if (!filename) {
        return res.status(400).json({ error: 'No filename provided' });
      }

      const documentId = await storeDocument(sessionId, userId, base64Data, filename, mimeType);

      return res.status(200).json({ documentId, sessionId });
    } catch (error) {
      console.error('Error storing document:', error);
      return res.status(500).json({ error: 'Failed to store document' });
    }
  } else if (req.method === 'GET') {
    // Retrieve document
    const { documentId, sessionId: querySessionId } = req.query;

    if (!documentId || typeof documentId !== 'string') {
      return res.status(400).json({ error: 'Invalid document ID' });
    }

    // Allow retrieving documents from other sessions (for cross-device persistence)
    const targetSessionId = (typeof querySessionId === 'string' && querySessionId)
      ? querySessionId
      : sessionId;

    try {
      const document = await getDocument(targetSessionId, documentId);

      if (!document) {
        return res.status(404).json({ error: 'Document not found' });
      }

      // Return document data
      res.setHeader('Content-Type', document.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${document.filename}"`);
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

// Configure API route to handle larger payloads
// 100MB raw * 1.33 base64 overhead ≈ 133MB; 150mb provides headroom
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '150mb',
    },
  },
};
