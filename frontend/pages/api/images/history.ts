import type { NextApiRequest, NextApiResponse } from 'next';

import type { ImageContext } from '@/types/imageBrief';

import { updateJsonAtomically } from '@/server/atomicJson';
import {
  GENERATED_IMAGE_ID_PATTERN,
  generatedImageKey,
  ownsGeneratedImage,
  readGeneratedImageRecords,
} from '@/server/images/generatedImage';
import {
  appendImageHistoryEntry,
  IMAGE_HISTORY_TTL_SECONDS,
  MAX_HISTORY_ENTRIES,
} from '@/server/images/historyStore';
import { imageHistoryKey } from '@/server/images/requestHelpers';
import {
  getStorageSessionId,
  requireAuthenticatedUser,
} from '@/server/session/_utils';
import { jsonGet } from '@/server/session/redis';

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
  imageContext?: ImageContext;
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

class ImageHistoryAccessError extends Error {}

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

async function validateOutputImageIds(
  imageIds: string[],
  userId: string,
  sessionId: string,
): Promise<string | null> {
  const invalidIndex = imageIds.findIndex(
    (imageId) => !GENERATED_IMAGE_ID_PATTERN.test(imageId),
  );
  const checked =
    invalidIndex === -1 ? imageIds : imageIds.slice(0, invalidIndex);
  const owners = await readGeneratedImageRecords(checked);
  for (const owner of owners) {
    if (!owner?.hasData) {
      return 'Generated image not found';
    }
    if (!ownsGeneratedImage(owner, { userId, sessionId })) {
      return 'Generated image does not belong to the current user';
    }
  }
  return invalidIndex === -1 ? null : 'Invalid image history entry';
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
      if (
        GENERATED_IMAGE_ID_PATTERN.test(imageId) &&
        !stillReferenced.has(imageId)
      ) {
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
  const owners = await readGeneratedImageRecords(imageIds);

  for (const [index, owner] of owners.entries()) {
    // A missing or expired output needs no cleanup. Do not let stale history
    // prevent a user from removing the history entry itself.
    if (!owner?.hasData) continue;

    if (!ownsGeneratedImage(owner, { userId, sessionId })) {
      return {
        imageIds: [],
        error: 'Generated image does not belong to the current user',
      };
    }

    ownedImageIds.push(imageIds[index]);
  }

  return { imageIds: ownedImageIds, error: null };
}

function isImageContext(value: unknown): value is ImageContext {
  if (!isObject(value) || !isObject(value.brief)) return false;
  const brief = value.brief;
  return (
    typeof value.originalPrompt === 'string' &&
    typeof value.prompt === 'string' &&
    ['assisted', 'exact', 'fallback'].includes(String(value.guidance)) &&
    isObject(value.params) &&
    Array.isArray(value.inputImages) &&
    value.inputImages.every(
      (image) => isObject(image) && typeof image.imageId === 'string',
    ) &&
    [
      'scene',
      'subject',
      'medium',
      'composition',
      'lighting',
      'intended_use',
    ].every((field) => typeof brief[field] === 'string') &&
    [
      'details',
      'exact_text',
      'changes',
      'preserve',
      'exclusions',
      'references',
    ].every((field) => isStringArray(brief[field])) &&
    isObject(brief.options)
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
    ...(isImageContext(value.imageContext) && {
      imageContext: value.imageContext,
    }),
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

function parseHistory(value: unknown): ImageHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseEntry)
    .filter(Boolean)
    .slice(0, MAX_HISTORY_ENTRIES) as ImageHistoryEntry[];
}

async function loadHistory(key: string): Promise<ImageHistoryEntry[]> {
  return parseHistory(await jsonGet(key));
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  const sessionId = getStorageSessionId(req, res);
  const userId = session.username;
  const key = imageHistoryKey(userId, sessionId);

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
      const nextHistory = await appendImageHistoryEntry(
        key,
        entry,
        async () => {
          const error = await validateOutputImageIds(
            entry.outputImageIds,
            userId,
            sessionId,
          );
          if (error) throw new ImageHistoryAccessError(error);
        },
      );
      return res.status(200).json({ history: nextHistory });
    } catch (error) {
      if (error instanceof ImageHistoryAccessError)
        return res.status(403).json({ error: error.message });
      console.error('images/history POST error:', error);
      return res.status(500).json({ error: 'Failed to save image history' });
    }
  }

  if (req.method === 'DELETE') {
    const { id, all, deleteAssets } = req.query;
    const deleteOutputAssets = shouldDeleteAssets(deleteAssets);
    const removeAll = all === '1' || all === 'true';
    if (!removeAll && (typeof id !== 'string' || !id)) {
      return res.status(400).json({ error: 'Missing id or all=1' });
    }
    try {
      let next: ImageHistoryEntry[] = [];
      let assetKeys: string[] = [];
      await updateJsonAtomically<unknown>(
        key,
        async (current) => {
          const existing = parseHistory(current);
          const removed = removeAll
            ? existing
            : existing.filter((entry) => entry.id === id);
          next = removeAll ? [] : existing.filter((entry) => entry.id !== id);
          assetKeys = [];
          if (!removed.length) return null;
          if (deleteOutputAssets) {
            const deletion = await ownedGeneratedImageIdsForDeletion(
              unreferencedOutputImageIds(removed, next),
              userId,
              sessionId,
            );
            if (deletion.error)
              throw new ImageHistoryAccessError(deletion.error);
            assetKeys = deletion.imageIds.map(generatedImageKey);
          }
          return next;
        },
        IMAGE_HISTORY_TTL_SECONDS,
        { keysToDelete: () => assetKeys },
      );
      return res.status(200).json({ history: next });
    } catch (error) {
      if (error instanceof ImageHistoryAccessError)
        return res.status(403).json({ error: error.message });
      console.error('images/history DELETE error:', error);
      return res.status(500).json({ error: 'Failed to delete image history' });
    }
  }

  res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
  return res.status(405).json({ error: 'Method not allowed' });
}
