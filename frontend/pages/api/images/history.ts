import type { NextApiRequest, NextApiResponse } from 'next';

import { getOrSetSessionId, getUserId } from '../session/_utils';
import { jsonDel, jsonGet, jsonSetWithExpiry, sessionKey } from '../session/redis';

const IMAGE_HISTORY_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_HISTORY_ENTRIES = 50;

type ImageMode = 'generate' | 'edit';

interface ImageRef {
  imageId: string;
  sessionId: string;
  userId?: string;
  mimeType?: string;
}

interface ImageHistoryEntry {
  id: string;
  mode: ImageMode;
  prompt: string;
  params: Record<string, unknown>;
  inputImages: ImageRef[];
  maskImage: ImageRef | null;
  outputImageIds: string[];
  model: string;
  createdAt: number;
}

function historyKey(userId: string, sessionId: string): string {
  if (userId && userId !== 'anon') {
    return sessionKey(['user', userId, 'imagePanelHistory']);
  }
  return sessionKey(['session', sessionId, 'imagePanelHistory']);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isImageRef(value: unknown): value is ImageRef {
  if (!isObject(value)) return false;
  return (
    typeof value.imageId === 'string' &&
    typeof value.sessionId === 'string' &&
    (value.userId === undefined || typeof value.userId === 'string') &&
    (value.mimeType === undefined || typeof value.mimeType === 'string')
  );
}

function parseEntry(value: unknown): ImageHistoryEntry | null {
  if (!isObject(value)) return null;
  if (value.mode !== 'generate' && value.mode !== 'edit') return null;
  if (
    typeof value.id !== 'string' ||
    typeof value.prompt !== 'string' ||
    !isObject(value.params) ||
    !Array.isArray(value.inputImages) ||
    !isStringArray(value.outputImageIds) ||
    typeof value.model !== 'string' ||
    typeof value.createdAt !== 'number'
  ) {
    return null;
  }
  if (!value.inputImages.every(isImageRef)) return null;
  if (value.maskImage !== null && !isImageRef(value.maskImage)) return null;
  if (value.outputImageIds.length === 0) return null;

  return {
    id: value.id,
    mode: value.mode,
    prompt: value.prompt,
    params: value.params,
    inputImages: value.inputImages,
    maskImage: value.maskImage,
    outputImageIds: value.outputImageIds,
    model: value.model,
    createdAt: value.createdAt,
  };
}

async function loadHistory(key: string): Promise<ImageHistoryEntry[]> {
  const value = await jsonGet(key);
  if (!Array.isArray(value)) return [];
  return value
    .map(parseEntry)
    .filter(Boolean)
    .slice(0, MAX_HISTORY_ENTRIES) as ImageHistoryEntry[];
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const sessionId = getOrSetSessionId(req, res);
  const userId = await getUserId(req, res);
  const key = historyKey(userId, sessionId);

  if (req.method === 'GET') {
    try {
      return res.status(200).json({ history: await loadHistory(key) });
    } catch (error) {
      console.error('images/history GET error:', error);
      return res.status(500).json({ error: 'Failed to load image history' });
    }
  }

  if (req.method === 'POST') {
    const entry = parseEntry(
      isObject(req.body) && 'entry' in req.body ? req.body.entry : req.body,
    );
    if (!entry) {
      return res.status(400).json({ error: 'Invalid image history entry' });
    }

    try {
      const existing = await loadHistory(key);
      const nextHistory = [
        entry,
        ...existing.filter((item) => item.id !== entry.id),
      ].slice(0, MAX_HISTORY_ENTRIES);

      await jsonSetWithExpiry(key, nextHistory, IMAGE_HISTORY_TTL_SECONDS);
      return res.status(200).json({ history: nextHistory });
    } catch (error) {
      console.error('images/history POST error:', error);
      return res.status(500).json({ error: 'Failed to save image history' });
    }
  }

  if (req.method === 'DELETE') {
    const { id, all } = req.query;
    try {
      if (all === '1' || all === 'true') {
        await jsonDel(key);
        return res.status(200).json({ history: [] });
      }
      if (typeof id !== 'string' || !id) {
        return res.status(400).json({ error: 'Missing id or all=1' });
      }
      const existing = await loadHistory(key);
      const next = existing.filter((entry) => entry.id !== id);
      if (next.length === existing.length) {
        return res.status(200).json({ history: existing });
      }
      if (next.length === 0) {
        await jsonDel(key);
      } else {
        await jsonSetWithExpiry(key, next, IMAGE_HISTORY_TTL_SECONDS);
      }
      return res.status(200).json({ history: next });
    } catch (error) {
      console.error('images/history DELETE error:', error);
      return res.status(500).json({ error: 'Failed to delete image history' });
    }
  }

  res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
  return res.status(405).json({ error: 'Method not allowed' });
}
