import type { NextApiRequest, NextApiResponse } from 'next';

import {
  getOrSetSessionId,
  requireAuthenticatedUser,
} from '@/server/session/_utils';
import {
  getRedis,
  jsonDel,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';

const IMAGE_HISTORY_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_HISTORY_ENTRIES = 50;
const IMAGE_ID_PATTERN = /^[a-f0-9-]+$/i;

type ImageMode = 'generate' | 'edit';

interface ImageRef {
  imageId: string;
  sessionId: string;
  userId?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
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
  usage?: Record<string, unknown>;
}

interface GeneratedImageRecord {
  data?: string;
  userId?: string;
  user?: string;
  sessionId?: string;
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
    (value.mimeType === undefined || typeof value.mimeType === 'string') &&
    (value.width === undefined || typeof value.width === 'number') &&
    (value.height === undefined || typeof value.height === 'number') &&
    (value.hasAlpha === undefined || typeof value.hasAlpha === 'boolean')
  );
}

function recordMatchesRequestOwner(
  record: GeneratedImageRecord,
  userId: string,
  sessionId: string,
): boolean {
  const ownerUserId = record.userId || record.user;
  if (ownerUserId) return ownerUserId === userId;
  return Boolean(record.sessionId && record.sessionId === sessionId);
}

async function loadGeneratedImageRecord(
  imageId: string,
): Promise<GeneratedImageRecord | null> {
  const redis = getRedis();
  const redisKey = `generated:image:${imageId}`;

  try {
    const jsonResult = (await redis.call('JSON.GET', redisKey, '$')) as
      | string
      | null;
    if (jsonResult) {
      const parsed = JSON.parse(jsonResult);
      const record = Array.isArray(parsed) ? parsed[0] : parsed;
      return isObject(record) ? record : null;
    }
  } catch {
    const plainResult = await redis.get(redisKey);
    if (plainResult) {
      try {
        const parsed = JSON.parse(plainResult);
        return isObject(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }

  return null;
}

async function validateOutputImageIds(
  imageIds: string[],
  userId: string,
  sessionId: string,
): Promise<string | null> {
  for (const imageId of imageIds) {
    if (!IMAGE_ID_PATTERN.test(imageId)) {
      return 'Invalid image history entry';
    }
    const record = await loadGeneratedImageRecord(imageId);
    if (!record?.data) {
      return 'Generated image not found';
    }
    if (!recordMatchesRequestOwner(record, userId, sessionId)) {
      return 'Generated image does not belong to the current user';
    }
  }
  return null;
}

function shouldDeleteAssets(value: string | string[] | undefined): boolean {
  return value === '1' || value === 'true';
}

function referencedImageIds(entries: ImageHistoryEntry[]): Set<string> {
  const imageIds = new Set<string>();
  for (const entry of entries) {
    for (const imageId of entry.outputImageIds) {
      imageIds.add(imageId);
    }
    for (const image of entry.inputImages) {
      imageIds.add(image.imageId);
    }
    if (entry.maskImage) {
      imageIds.add(entry.maskImage.imageId);
    }
  }
  return imageIds;
}

function unreferencedOutputImageIds(
  removedEntries: ImageHistoryEntry[],
  remainingEntries: ImageHistoryEntry[],
): string[] {
  const stillReferenced = referencedImageIds(remainingEntries);
  const outputImageIds = new Set<string>();

  for (const entry of removedEntries) {
    for (const imageId of entry.outputImageIds) {
      if (IMAGE_ID_PATTERN.test(imageId) && !stillReferenced.has(imageId)) {
        outputImageIds.add(imageId);
      }
    }
  }

  return [...outputImageIds];
}

async function ownedGeneratedImageIdsForDeletion(
  imageIds: string[],
  userId: string,
  sessionId: string,
): Promise<{ imageIds: string[]; error: string | null }> {
  const ownedImageIds: string[] = [];

  for (const imageId of imageIds) {
    const record = await loadGeneratedImageRecord(imageId);

    // A missing or expired output needs no cleanup. Do not let stale history
    // prevent a user from removing the history entry itself.
    if (!record?.data) continue;

    if (!recordMatchesRequestOwner(record, userId, sessionId)) {
      return {
        imageIds: [],
        error: 'Generated image does not belong to the current user',
      };
    }

    ownedImageIds.push(imageId);
  }

  return { imageIds: ownedImageIds, error: null };
}

async function deleteGeneratedImageAssets(imageIds: string[]): Promise<void> {
  if (imageIds.length === 0) return;
  await getRedis().del(
    ...imageIds.map((imageId) => `generated:image:${imageId}`),
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
    ...(isObject(value.usage) && { usage: value.usage }),
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
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  const sessionId = getOrSetSessionId(req, res);
  const userId = session.username;
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
      const validationError = await validateOutputImageIds(
        entry.outputImageIds,
        userId,
        sessionId,
      );
      if (validationError) {
        return res.status(403).json({ error: validationError });
      }

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
    const { id, all, deleteAssets } = req.query;
    const deleteOutputAssets = shouldDeleteAssets(deleteAssets);
    try {
      if (all === '1' || all === 'true') {
        let assetIdsToDelete: string[] = [];
        if (deleteOutputAssets) {
          const existing = await loadHistory(key);
          const candidates = unreferencedOutputImageIds(existing, []);
          const assetDeletion = await ownedGeneratedImageIdsForDeletion(
            candidates,
            userId,
            sessionId,
          );
          if (assetDeletion.error) {
            return res.status(403).json({ error: assetDeletion.error });
          }
          assetIdsToDelete = assetDeletion.imageIds;
        }

        await jsonDel(key);
        await deleteGeneratedImageAssets(assetIdsToDelete);
        return res.status(200).json({ history: [] });
      }
      if (typeof id !== 'string' || !id) {
        return res.status(400).json({ error: 'Missing id or all=1' });
      }
      const existing = await loadHistory(key);
      const removedEntries = existing.filter((entry) => entry.id === id);
      const next = existing.filter((entry) => entry.id !== id);
      if (next.length === existing.length) {
        return res.status(200).json({ history: existing });
      }

      let assetIdsToDelete: string[] = [];
      if (deleteOutputAssets) {
        const candidates = unreferencedOutputImageIds(removedEntries, next);
        const assetDeletion = await ownedGeneratedImageIdsForDeletion(
          candidates,
          userId,
          sessionId,
        );
        if (assetDeletion.error) {
          return res.status(403).json({ error: assetDeletion.error });
        }
        assetIdsToDelete = assetDeletion.imageIds;
      }

      if (next.length === 0) {
        await jsonDel(key);
      } else {
        await jsonSetWithExpiry(key, next, IMAGE_HISTORY_TTL_SECONDS);
      }
      await deleteGeneratedImageAssets(assetIdsToDelete);
      return res.status(200).json({ history: next });
    } catch (error) {
      console.error('images/history DELETE error:', error);
      return res.status(500).json({ error: 'Failed to delete image history' });
    }
  }

  res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
  return res.status(405).json({ error: 'Method not allowed' });
}
