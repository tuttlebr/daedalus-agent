import type { NextApiRequest, NextApiResponse } from 'next';

import type { ImageContext } from '@/types/imageBrief';

import { updateJsonAtomically } from '@/server/atomicJson';
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
import { getRedis, jsonGet } from '@/server/session/redis';

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

interface GeneratedImageRecord {
  data?: string;
  userId?: string;
  user?: string;
  sessionId?: string;
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

/**
 * Ownership checks need the owner fields and whether image bytes exist, not
 * the multi-megabyte base64 payload. RedisJSON records return only those
 * fields and the payload length; legacy plain-string records are still read
 * whole. Missing keys return nil.
 */
const GENERATED_IMAGE_OWNER_LUA = `
local reply = redis.call('TYPE', KEYS[1])
local kind = type(reply) == 'table' and reply['ok'] or reply
if kind == 'none' then return false end
if kind == 'string' then return {'string', redis.call('GET', KEYS[1])} end
if not string.find(string.lower(kind), 'rejson', 1, true) then return false end
local owner = redis.call('JSON.GET', KEYS[1], '$.userId', '$.user', '$.sessionId')
local length = redis.call('JSON.STRLEN', KEYS[1], '$.data')[1]
return {'json', owner, length or 0}
`;

interface GeneratedImageOwner {
  hasData: boolean;
  userId?: string;
  user?: string;
  sessionId?: string;
}

function firstPathValue(owner: Record<string, unknown>, path: string) {
  const values = owner[path];
  return Array.isArray(values) ? values[0] : undefined;
}

async function loadGeneratedImageOwner(
  imageId: string,
): Promise<GeneratedImageOwner | null> {
  const reply = (await getRedis().eval(
    GENERATED_IMAGE_OWNER_LUA,
    1,
    `generated:image:${imageId}`,
  )) as [string, string | null, number?] | null;
  if (!reply) return null;
  const [kind, payload, dataLength] = reply;
  if (!payload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  if (kind === 'string') {
    const record = parsed as GeneratedImageRecord;
    return { ...record, hasData: Boolean(record.data) };
  }
  return {
    hasData: Number(dataLength) > 0,
    userId: firstPathValue(parsed, '$.userId') as string | undefined,
    user: firstPathValue(parsed, '$.user') as string | undefined,
    sessionId: firstPathValue(parsed, '$.sessionId') as string | undefined,
  };
}

/** Read every candidate in one concurrent batch, then decide in order. */
async function loadGeneratedImageOwners(
  imageIds: string[],
): Promise<(GeneratedImageOwner | null)[]> {
  return Promise.all(imageIds.map(loadGeneratedImageOwner));
}

async function validateOutputImageIds(
  imageIds: string[],
  userId: string,
  sessionId: string,
): Promise<string | null> {
  const invalidIndex = imageIds.findIndex(
    (imageId) => !IMAGE_ID_PATTERN.test(imageId),
  );
  const checked =
    invalidIndex === -1 ? imageIds : imageIds.slice(0, invalidIndex);
  const owners = await loadGeneratedImageOwners(checked);
  for (const owner of owners) {
    if (!owner?.hasData) {
      return 'Generated image not found';
    }
    if (!recordMatchesRequestOwner(owner, userId, sessionId)) {
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
  const owners = await loadGeneratedImageOwners(imageIds);

  for (const [index, owner] of owners.entries()) {
    // A missing or expired output needs no cleanup. Do not let stale history
    // prevent a user from removing the history entry itself.
    if (!owner?.hasData) continue;

    if (!recordMatchesRequestOwner(owner, userId, sessionId)) {
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
            assetKeys = deletion.imageIds.map(
              (imageId) => `generated:image:${imageId}`,
            );
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
