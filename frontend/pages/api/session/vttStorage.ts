import { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey, jsonGet, jsonDel, jsonSetWithExpiry } from './redis';
import { getUserId, getOrSetSessionId } from './_utils';
import crypto from 'crypto';

const VTT_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_VTT_SIZE = 10 * 1024 * 1024; // 10MB limit for VTT files

export interface StoredVTT {
  id: string;
  data: string; // VTT content stored as text (not base64)
  mimeType: string;
  filename: string;
  size: number;
  createdAt: number;
  sessionId: string;
  userId?: string;
}

// Generate a unique ID for the VTT file
function generateVTTId(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Store VTT in Redis
export async function storeVTT(
  sessionId: string,
  userId: string | undefined,
  content: string,
  filename: string,
  mimeType: string = 'text/vtt'
): Promise<string> {
  const redis = getRedis();
  const vttId = generateVTTId();

  const size = Buffer.byteLength(content, 'utf8');

  if (size > MAX_VTT_SIZE) {
    throw new Error('VTT file size exceeds maximum allowed size (10MB)');
  }

  const vttData: StoredVTT = {
    id: vttId,
    data: content, // Store VTT as plain text, not base64
    mimeType,
    filename,
    size,
    createdAt: Date.now(),
    sessionId,
    userId
  };

  const key = sessionKey(['vtt', sessionId, vttId]);
  await jsonSetWithExpiry(key, vttData, VTT_EXPIRY_SECONDS);

  // Also store a reference in a session-specific set for easy cleanup
  const sessionVTTsKey = sessionKey(['session-vtts', sessionId]);
  await redis.sadd(sessionVTTsKey, vttId);
  await redis.expire(sessionVTTsKey, VTT_EXPIRY_SECONDS);

  return vttId;
}

// Retrieve VTT from Redis
export async function getVTT(
  sessionId: string,
  vttId: string
): Promise<StoredVTT | null> {
  const key = sessionKey(['vtt', sessionId, vttId]);
  const data = await jsonGet(key);
  return data as StoredVTT | null;
}

// Delete a specific VTT file
export async function deleteVTT(
  sessionId: string,
  vttId: string
): Promise<boolean> {
  const redis = getRedis();
  const key = sessionKey(['vtt', sessionId, vttId]);

  // Remove from Redis
  const deleted = await jsonDel(key);

  // Remove from session set
  if (deleted > 0) {
    const sessionVTTsKey = sessionKey(['session-vtts', sessionId]);
    await redis.srem(sessionVTTsKey, vttId);
  }

  return deleted > 0;
}

// Clean up all VTT files for a session
export async function cleanupSessionVTTs(sessionId: string): Promise<number> {
  const redis = getRedis();
  const sessionVTTsKey = sessionKey(['session-vtts', sessionId]);

  // Get all VTT IDs for this session
  const vttIds = await redis.smembers(sessionVTTsKey);

  let deletedCount = 0;
  for (const vttId of vttIds) {
    const key = sessionKey(['vtt', sessionId, vttId]);
    const deleted = await jsonDel(key);
    if (deleted > 0) {
      deletedCount++;
    }
  }

  // Clean up the set itself
  await redis.del(sessionVTTsKey);

  return deletedCount;
}

// List all VTT files for a session
export async function listSessionVTTs(sessionId: string): Promise<Array<{ id: string; filename: string; size: number; createdAt: number }>> {
  const redis = getRedis();
  const sessionVTTsKey = sessionKey(['session-vtts', sessionId]);

  const vttIds = await redis.smembers(sessionVTTsKey);
  const vtts: Array<{ id: string; filename: string; size: number; createdAt: number }> = [];

  for (const vttId of vttIds) {
    const vtt = await getVTT(sessionId, vttId);
    if (vtt) {
      vtts.push({
        id: vtt.id,
        filename: vtt.filename,
        size: vtt.size,
        createdAt: vtt.createdAt,
      });
    }
  }

  return vtts.sort((a, b) => b.createdAt - a.createdAt);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const sessionId = getOrSetSessionId(req, res);
  const userId = await getUserId(req, res);

  if (req.method === 'POST') {
    // Store VTT file
    try {
      const { content, filename, mimeType } = req.body;

      if (!content) {
        return res.status(400).json({ error: 'No VTT content provided' });
      }

      if (!filename) {
        return res.status(400).json({ error: 'No filename provided' });
      }

      const vttId = await storeVTT(sessionId, userId, content, filename, mimeType || 'text/vtt');

      return res.status(200).json({ vttId, sessionId });
    } catch (error) {
      console.error('Error storing VTT:', error);
      const message = error instanceof Error ? error.message : 'Failed to store VTT';
      return res.status(500).json({ error: message });
    }
  } else if (req.method === 'GET') {
    const { vttId, sessionId: querySessionId, list } = req.query;

    // List all VTT files for the session
    if (list === 'true') {
      try {
        const vtts = await listSessionVTTs(sessionId);
        return res.status(200).json({ vtts });
      } catch (error) {
        console.error('Error listing VTT files:', error);
        return res.status(500).json({ error: 'Failed to list VTT files' });
      }
    }

    // Retrieve specific VTT file
    if (!vttId || typeof vttId !== 'string') {
      return res.status(400).json({ error: 'Invalid VTT ID' });
    }

    // Allow retrieving VTT from other sessions (for cross-device persistence)
    const targetSessionId = (typeof querySessionId === 'string' && querySessionId)
      ? querySessionId
      : sessionId;

    try {
      const vtt = await getVTT(targetSessionId, vttId);

      if (!vtt) {
        return res.status(404).json({ error: 'VTT file not found' });
      }

      // Return VTT content as text
      res.setHeader('Content-Type', vtt.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${vtt.filename}"`);
      res.setHeader('Cache-Control', 'private, max-age=3600');

      return res.status(200).send(vtt.data);
    } catch (error) {
      console.error('Error retrieving VTT:', error);
      return res.status(500).json({ error: 'Failed to retrieve VTT' });
    }
  } else if (req.method === 'DELETE') {
    // Delete VTT file
    const { vttId } = req.query;

    if (!vttId || typeof vttId !== 'string') {
      return res.status(400).json({ error: 'Invalid VTT ID' });
    }

    try {
      const deleted = await deleteVTT(sessionId, vttId);

      if (!deleted) {
        return res.status(404).json({ error: 'VTT file not found' });
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error deleting VTT:', error);
      return res.status(500).json({ error: 'Failed to delete VTT' });
    }
  }

  res.setHeader('Allow', ['POST', 'GET', 'DELETE']);
  return res.status(405).json({ error: 'Method not allowed' });
}

// Configure API route to handle larger payloads
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '15mb', // Allow up to 15MB for VTT content
    },
  },
};
