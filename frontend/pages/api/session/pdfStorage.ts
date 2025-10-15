import { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey, jsonGet, jsonDel, jsonSetWithExpiry } from './redis';
import { getUserId, getOrSetSessionId } from './_utils';
import crypto from 'crypto';

const PDF_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10MB limit

export interface StoredPDF {
  id: string;
  data: string;
  mimeType: string;
  filename: string;
  size: number;
  createdAt: number;
  sessionId: string;
  userId?: string;
}

// Generate a unique ID for the PDF
function generatePDFId(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Store PDF in Redis
export async function storePDF(
  sessionId: string,
  userId: string | undefined,
  base64Data: string,
  filename: string,
  mimeType: string = 'application/pdf'
): Promise<string> {
  const redis = getRedis();
  const pdfId = generatePDFId();

  // Remove data URL prefix if present
  const cleanBase64 = base64Data.replace(/^data:application\/pdf;base64,/, '');
  const size = Buffer.from(cleanBase64, 'base64').length;

  if (size > MAX_PDF_SIZE) {
    throw new Error('PDF size exceeds maximum allowed size');
  }

  const pdfData: StoredPDF = {
    id: pdfId,
    data: cleanBase64,
    mimeType,
    filename,
    size,
    createdAt: Date.now(),
    sessionId,
    userId
  };

  const key = sessionKey(['pdf', sessionId, pdfId]);
  await jsonSetWithExpiry(key, pdfData, PDF_EXPIRY_SECONDS);

  // Also store a reference in a session-specific set for easy cleanup
  const sessionPDFsKey = sessionKey(['session-pdfs', sessionId]);
  await redis.sadd(sessionPDFsKey, pdfId);
  await redis.expire(sessionPDFsKey, PDF_EXPIRY_SECONDS);

  return pdfId;
}

// Retrieve PDF from Redis
export async function getPDF(
  sessionId: string,
  pdfId: string
): Promise<StoredPDF | null> {
  const key = sessionKey(['pdf', sessionId, pdfId]);
  const data = await jsonGet(key);
  return data as StoredPDF | null;
}

// Delete a specific PDF
export async function deletePDF(
  sessionId: string,
  pdfId: string
): Promise<boolean> {
  const redis = getRedis();
  const key = sessionKey(['pdf', sessionId, pdfId]);

  // Remove from Redis
  const deleted = await jsonDel(key);

  // Remove from session set
  if (deleted > 0) {
    const sessionPDFsKey = sessionKey(['session-pdfs', sessionId]);
    await redis.srem(sessionPDFsKey, pdfId);
  }

  return deleted > 0;
}

// Clean up all PDFs for a session
export async function cleanupSessionPDFs(sessionId: string): Promise<number> {
  const redis = getRedis();
  const sessionPDFsKey = sessionKey(['session-pdfs', sessionId]);

  // Get all PDF IDs for this session
  const pdfIds = await redis.smembers(sessionPDFsKey);

  let deletedCount = 0;
  for (const pdfId of pdfIds) {
    const key = sessionKey(['pdf', sessionId, pdfId]);
    const deleted = await jsonDel(key);
    if (deleted > 0) {
      deletedCount++;
    }
  }

  // Clean up the set itself
  await redis.del(sessionPDFsKey);

  return deletedCount;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const sessionId = getOrSetSessionId(req, res);
  const userId = await getUserId(req, res);

  if (req.method === 'POST') {
    // Store PDF
    try {
      const { base64Data, filename, mimeType } = req.body;

      if (!base64Data) {
        return res.status(400).json({ error: 'No PDF data provided' });
      }

      if (!filename) {
        return res.status(400).json({ error: 'No filename provided' });
      }

      const pdfId = await storePDF(sessionId, userId, base64Data, filename, mimeType);

      return res.status(200).json({ pdfId, sessionId });
    } catch (error) {
      console.error('Error storing PDF:', error);
      return res.status(500).json({ error: 'Failed to store PDF' });
    }
  } else if (req.method === 'GET') {
    // Retrieve PDF
    const { pdfId, sessionId: querySessionId } = req.query;

    if (!pdfId || typeof pdfId !== 'string') {
      return res.status(400).json({ error: 'Invalid PDF ID' });
    }

    // Allow retrieving PDFs from other sessions (for cross-device persistence)
    const targetSessionId = (typeof querySessionId === 'string' && querySessionId)
      ? querySessionId
      : sessionId;

    try {
      const pdf = await getPDF(targetSessionId, pdfId);

      if (!pdf) {
        return res.status(404).json({ error: 'PDF not found' });
      }

      // Return PDF data
      res.setHeader('Content-Type', pdf.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${pdf.filename}"`);
      res.setHeader('Cache-Control', 'private, max-age=3600');

      const buffer = Buffer.from(pdf.data, 'base64');
      return res.status(200).send(buffer);
    } catch (error) {
      console.error('Error retrieving PDF:', error);
      return res.status(500).json({ error: 'Failed to retrieve PDF' });
    }
  } else if (req.method === 'DELETE') {
    // Delete PDF
    const { pdfId } = req.query;

    if (!pdfId || typeof pdfId !== 'string') {
      return res.status(400).json({ error: 'Invalid PDF ID' });
    }

    try {
      const deleted = await deletePDF(sessionId, pdfId);

      if (!deleted) {
        return res.status(404).json({ error: 'PDF not found' });
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error deleting PDF:', error);
      return res.status(500).json({ error: 'Failed to delete PDF' });
    }
  }

  res.setHeader('Allow', ['POST', 'GET', 'DELETE']);
  return res.status(405).json({ error: 'Method not allowed' });
}

// Configure API route to handle larger payloads
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};
