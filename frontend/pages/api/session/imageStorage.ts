import { NextApiRequest, NextApiResponse } from 'next';

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
import decodeHeic from 'heic-decode';
import sharp from 'sharp';

export const config = {
  api: {
    bodyParser: {
      // A 10 MiB decoded image needs about 13.34 MiB as base64 JSON.
      sizeLimit: '14mb',
    },
  },
};

const IMAGE_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB limit
const THUMBNAIL_MAX_SIZE = 400; // Max dimension for thumbnails
const THUMBNAIL_QUALITY = 80; // JPEG quality for thumbnails
const VLM_MAX_DIMENSION = 4096; // Cap oversized uploads before VLM ingestion
const VLM_IMAGE_QUALITY = 92; // Preserve detail while normalizing decoder-sensitive JPEGs
const EDIT_IMAGE_QUALITY = 95;

export interface StoredImage {
  id: string;
  data: string;
  mimeType: string;
  editData?: string; // Single-frame PNG/JPEG prepared for the OpenAI Image API
  editMimeType?: string;
  vlmData?: string; // Normalized image payload for VLM ingestion
  vlmMimeType?: string;
  size: number;
  createdAt: number;
  sessionId: string;
  userId?: string;
  thumbnail?: string; // Base64 thumbnail data
  thumbnailMimeType?: string;
  width?: number;
  height?: number;
}

export interface StoreImageResult {
  imageId: string;
  mimeType: string;
}

class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedImageError';
  }
}

// Generate a unique ID for the image
function generateImageId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function mimeTypeForFormat(
  format: string | undefined,
  fallback: string,
): string {
  if (!format) return fallback;
  const formatToMime: Record<string, string> = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    heif: 'image/heif',
  };
  return formatToMime[format] || fallback;
}

const HEIC_HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
]);

function hasHeicOrHeifBrand(buffer: Buffer): boolean {
  if (buffer.length < 12 || buffer.toString('ascii', 4, 8) !== 'ftyp') {
    return false;
  }

  const ftypSize = buffer.readUInt32BE(0);
  const brandBytesToInspect = Math.min(buffer.length, ftypSize, 128);
  for (let offset = 8; offset + 4 <= brandBytesToInspect; offset += 4) {
    if (HEIC_HEIF_BRANDS.has(buffer.toString('ascii', offset, offset + 4))) {
      return true;
    }
  }
  return false;
}

function rgbaHasTransparency(data: Uint8ClampedArray): boolean {
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] !== 255) return true;
  }
  return false;
}

function assertNormalizedEditImage(buffer: Buffer, mimeType: string): void {
  const isPng = buffer
    .subarray(0, 8)
    .equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const isJpeg =
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;

  if (
    (mimeType === 'image/png' && !isPng) ||
    (mimeType === 'image/jpeg' && !isJpeg) ||
    (mimeType !== 'image/png' && mimeType !== 'image/jpeg')
  ) {
    throw new UnsupportedImageError(
      'Image normalization did not produce a valid PNG or JPEG file.',
    );
  }
}

async function normalizeDecodedHeic(buffer: Buffer): Promise<{
  buffer: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}> {
  const decoded = await decodeHeic({ buffer });
  const { data, width, height } = decoded;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    data.length !== width * height * 4
  ) {
    throw new UnsupportedImageError(
      'HEIC/HEIF decoder returned invalid pixel data.',
    );
  }

  const rawPixels = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const hasTransparency = rgbaHasTransparency(data);
  const pipeline = sharp(rawPixels, {
    raw: { width, height, channels: 4 },
  }).toColorspace('srgb');
  const mimeType = hasTransparency ? 'image/png' : 'image/jpeg';
  const normalizedBuffer = hasTransparency
    ? await pipeline.png().toBuffer()
    : await pipeline
        .flatten({ background: '#ffffff' })
        .jpeg({
          quality: EDIT_IMAGE_QUALITY,
          chromaSubsampling: '4:4:4',
          progressive: false,
          mozjpeg: false,
        })
        .toBuffer();

  assertNormalizedEditImage(normalizedBuffer, mimeType);
  return { buffer: normalizedBuffer, mimeType, width, height };
}

async function normalizeEditImage(
  buffer: Buffer,
  sourceFormat: string | undefined,
  sourceHasAlpha: boolean | undefined,
): Promise<{ buffer: Buffer; mimeType: 'image/png' | 'image/jpeg' }> {
  const usePng = sourceFormat === 'png' || sourceHasAlpha === true;
  let pipeline = sharp(buffer).rotate().toColorspace('srgb');
  let normalizedBuffer: Buffer;
  let mimeType: 'image/png' | 'image/jpeg';

  if (usePng) {
    normalizedBuffer = await pipeline.png().toBuffer();
    mimeType = 'image/png';
  } else {
    pipeline = pipeline.flatten({ background: '#ffffff' });
    normalizedBuffer = await pipeline
      .jpeg({
        quality: EDIT_IMAGE_QUALITY,
        chromaSubsampling: '4:4:4',
        progressive: false,
        mozjpeg: false,
      })
      .toBuffer();
    mimeType = 'image/jpeg';
  }

  assertNormalizedEditImage(normalizedBuffer, mimeType);
  return { buffer: normalizedBuffer, mimeType };
}

// Preserve a display copy and prepare separate, decoder-safe derivatives.
async function processImage(
  base64Data: string,
  mimeType: string,
): Promise<{
  data: string;
  mimeType: string;
  editData: string;
  editMimeType: string;
  vlmData?: string;
  vlmMimeType?: string;
  size: number;
  thumbnail?: string;
  thumbnailMimeType?: string;
  width?: number;
  height?: number;
}> {
  // Remove data URL prefix if present
  const cleanBase64 = base64Data.replace(
    /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,/i,
    '',
  );
  const buffer = Buffer.from(cleanBase64, 'base64');

  const claimsHeicMimeType = /^image\/hei[cf]$/i.test(mimeType);
  const hasHeicBrand = hasHeicOrHeifBrand(buffer);
  let sourceMetadata:
    | Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>
    | undefined;
  try {
    sourceMetadata = await sharp(buffer).metadata();
  } catch (error) {
    if (!claimsHeicMimeType && !hasHeicBrand) throw error;
  }
  const requiresHeicNormalization =
    hasHeicBrand ||
    sourceMetadata?.format === 'heif' ||
    (claimsHeicMimeType && sourceMetadata === undefined);

  try {
    let storedBuffer: Buffer;
    let actualMimeType: string;
    let editBuffer: Buffer;
    let editMimeType: 'image/png' | 'image/jpeg';
    if (requiresHeicNormalization) {
      const normalized = await normalizeDecodedHeic(buffer);
      storedBuffer = normalized.buffer;
      actualMimeType = normalized.mimeType;
      editBuffer = normalized.buffer;
      editMimeType = normalized.mimeType;
    } else {
      const metadata = sourceMetadata ?? (await sharp(buffer).metadata());
      const normalized = await normalizeEditImage(
        buffer,
        metadata.format,
        metadata.hasAlpha,
      );
      storedBuffer = buffer;
      actualMimeType = mimeTypeForFormat(metadata.format, mimeType);
      editBuffer = normalized.buffer;
      editMimeType = normalized.mimeType;
    }

    let vlmData: string | undefined;
    let vlmMimeType: string | undefined;
    try {
      const vlmBuffer = await sharp(editBuffer)
        .resize(VLM_MAX_DIMENSION, VLM_MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .flatten({ background: '#ffffff' })
        .toColorspace('srgb')
        .jpeg({
          quality: VLM_IMAGE_QUALITY,
          progressive: false,
          mozjpeg: false,
        })
        .toBuffer();

      vlmData = vlmBuffer.toString('base64');
      vlmMimeType = 'image/jpeg';
    } catch (vlmError) {
      console.error('Failed to generate VLM-normalized image:', vlmError);
    }

    // Generate thumbnail if image is larger than thumbnail size
    let thumbnail: string | undefined;
    let thumbnailMimeType: string | undefined;
    const editMetadata = await sharp(editBuffer).metadata();
    const width = editMetadata.width || 0;
    const height = editMetadata.height || 0;

    if (width > THUMBNAIL_MAX_SIZE || height > THUMBNAIL_MAX_SIZE) {
      try {
        const thumbnailBuffer = await sharp(editBuffer)
          .resize(THUMBNAIL_MAX_SIZE, THUMBNAIL_MAX_SIZE, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: THUMBNAIL_QUALITY })
          .toBuffer();

        thumbnail = thumbnailBuffer.toString('base64');
        thumbnailMimeType = 'image/jpeg';
        console.log(
          `Generated thumbnail: ${width}x${height} -> ${THUMBNAIL_MAX_SIZE}px max, ${thumbnailBuffer.length} bytes`,
        );
      } catch (thumbError) {
        console.error('Failed to generate thumbnail:', thumbError);
        // Continue without thumbnail
      }
    }

    return {
      data: storedBuffer.toString('base64'),
      mimeType: actualMimeType,
      editData: editBuffer.toString('base64'),
      editMimeType,
      vlmData,
      vlmMimeType,
      size: storedBuffer.length,
      thumbnail,
      thumbnailMimeType,
      width,
      height,
    };
  } catch (error) {
    console.error('Image normalization failed:', error);
    if (error instanceof UnsupportedImageError) throw error;
    throw new UnsupportedImageError(
      requiresHeicNormalization
        ? 'Unable to decode this HEIC/HEIF image.'
        : 'Unable to decode and normalize this image.',
    );
  }
}

// Store image in Redis
export async function storeImage(
  sessionId: string,
  userId: string | undefined,
  base64Data: string,
  mimeType: string = 'image/png',
): Promise<StoreImageResult> {
  const redis = getRedis();
  const imageId = generateImageId();

  // Preserve the display image and build API/VLM-safe derivatives.
  const processed = await processImage(base64Data, mimeType);

  if (processed.size > MAX_IMAGE_SIZE) {
    throw new Error('Image size exceeds maximum allowed size');
  }

  const imageData: StoredImage = {
    id: imageId,
    data: processed.data,
    mimeType: processed.mimeType,
    editData: processed.editData,
    editMimeType: processed.editMimeType,
    vlmData: processed.vlmData,
    vlmMimeType: processed.vlmMimeType,
    size: processed.size,
    createdAt: Date.now(),
    sessionId,
    userId,
    thumbnail: processed.thumbnail,
    thumbnailMimeType: processed.thumbnailMimeType,
    width: processed.width,
    height: processed.height,
  };

  // Use user-specific key for authenticated users, session-specific for anonymous
  const key = userId
    ? sessionKey(['user', userId, 'image', imageId])
    : sessionKey(['image', sessionId, imageId]);

  await jsonSetWithExpiry(key, imageData, IMAGE_EXPIRY_SECONDS);

  // Also store a reference for easy cleanup
  if (userId) {
    // For authenticated users, store in user-specific set
    const userImagesKey = sessionKey(['user', userId, 'images']);
    await redis.sadd(userImagesKey, imageId);
    await redis.expire(userImagesKey, IMAGE_EXPIRY_SECONDS);
  } else {
    // For anonymous users, store in session-specific set
    const sessionImagesKey = sessionKey(['session-images', sessionId]);
    await redis.sadd(sessionImagesKey, imageId);
    await redis.expire(sessionImagesKey, IMAGE_EXPIRY_SECONDS);
  }

  return { imageId, mimeType: processed.mimeType };
}

// Retrieve image from Redis
export async function getImage(
  sessionId: string,
  imageId: string,
  userId?: string,
): Promise<StoredImage | null> {
  // Try user-specific key first if userId is provided
  if (userId) {
    const userKey = sessionKey(['user', userId, 'image', imageId]);
    const userImage = (await jsonGet(userKey)) as StoredImage | null;
    if (userImage) {
      return userImage;
    }
  }

  // Fall back to session-specific key (for backward compatibility)
  const key = sessionKey(['image', sessionId, imageId]);
  return (await jsonGet(key)) as StoredImage | null;
}

// Delete image from Redis
export async function deleteImage(
  sessionId: string,
  imageId: string,
  userId?: string,
): Promise<boolean> {
  const redis = getRedis();
  let result = 0;

  // Try to delete from user-specific key if userId is provided
  if (userId) {
    const userKey = sessionKey(['user', userId, 'image', imageId]);
    result = await jsonDel(userKey);

    // Also remove from user images set
    if (result > 0) {
      const userImagesKey = sessionKey(['user', userId, 'images']);
      await redis.srem(userImagesKey, imageId);
    }
  }

  // Also try session-specific key (for backward compatibility)
  if (result === 0) {
    const key = sessionKey(['image', sessionId, imageId]);
    result = await jsonDel(key);

    // Also remove from session images set
    const sessionImagesKey = sessionKey(['session-images', sessionId]);
    await redis.srem(sessionImagesKey, imageId);
  }

  return result > 0;
}

// Get all images for a session
export async function getSessionImages(sessionId: string): Promise<string[]> {
  const redis = getRedis();
  const sessionImagesKey = sessionKey(['session-images', sessionId]);

  return await redis.smembers(sessionImagesKey);
}

// Get all images for a user
export async function getUserImages(userId: string): Promise<string[]> {
  const redis = getRedis();
  const userImagesKey = sessionKey(['user', userId, 'images']);

  return await redis.smembers(userImagesKey);
}

// Clean up all images for a session
export async function cleanupSessionImages(
  sessionId: string,
  userId?: string,
): Promise<number> {
  const redis = getRedis();
  let deletedCount = 0;

  // Clean up user images if userId is provided
  if (userId) {
    const userImageIds = await getUserImages(userId);
    for (const imageId of userImageIds) {
      const key = sessionKey(['user', userId, 'image', imageId]);
      const result = await redis.del(key);
      if (result > 0) {
        deletedCount++;
      }
    }
    // Clean up the user images set
    const userImagesKey = sessionKey(['user', userId, 'images']);
    await redis.del(userImagesKey);
  }

  // Also clean up session images (for anonymous users or backward compatibility)
  const imageIds = await getSessionImages(sessionId);
  for (const imageId of imageIds) {
    const deleted = await deleteImage(sessionId, imageId, userId);
    if (deleted) deletedCount++;
  }

  // Delete the session images set
  const sessionImagesKey = sessionKey(['session-images', sessionId]);
  await redis.del(sessionImagesKey);

  return deletedCount;
}

// Touch image to refresh its TTL (extend expiry when image is still in use)
export async function touchImage(
  imageId: string,
  userId?: string,
  sessionId?: string,
): Promise<boolean> {
  const redis = getRedis();

  // Try user-specific key first if userId is provided
  if (userId) {
    const userKey = sessionKey(['user', userId, 'image', imageId]);
    const exists = await redis.exists(userKey);
    if (exists) {
      await redis.expire(userKey, IMAGE_EXPIRY_SECONDS);
      console.log(
        `Touched image ${imageId} for user ${userId}, TTL refreshed to ${IMAGE_EXPIRY_SECONDS}s`,
      );
      return true;
    }
  }

  // Try session-specific key
  if (sessionId) {
    const key = sessionKey(['image', sessionId, imageId]);
    const exists = await redis.exists(key);
    if (exists) {
      await redis.expire(key, IMAGE_EXPIRY_SECONDS);
      console.log(
        `Touched image ${imageId} for session ${sessionId}, TTL refreshed to ${IMAGE_EXPIRY_SECONDS}s`,
      );
      return true;
    }
  }

  const generatedKey = `generated:image:${imageId}`;
  const generatedExists = await redis.exists(generatedKey);
  if (generatedExists) {
    await redis.expire(generatedKey, IMAGE_EXPIRY_SECONDS);
    console.log(
      `Touched generated image ${imageId}, TTL refreshed to ${IMAGE_EXPIRY_SECONDS}s`,
    );
    return true;
  }

  return false;
}

// Generous backstop above legitimate batch uploads (batch max ~15 images);
// the per-image decode/VLM re-encode is CPU/memory heavy, so cap floods.
const IMAGE_UPLOAD_RATE_LIMIT = ruleFromEnv(
  'image-upload',
  'RATE_LIMIT_IMAGE_UPLOAD',
  200,
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
    if (!(await enforceRateLimit(res, IMAGE_UPLOAD_RATE_LIMIT, userId))) return;
    // Store image
    try {
      const { base64Data, mimeType } = req.body;

      if (!base64Data) {
        return res.status(400).json({ error: 'No image data provided' });
      }

      const stored = await storeImage(sessionId, userId, base64Data, mimeType);

      return res.status(200).json({ ...stored, sessionId, userId });
    } catch (error) {
      console.error('Error storing image:', error);
      if (error instanceof UnsupportedImageError) {
        return res.status(415).json({ error: error.message });
      }
      if (
        error instanceof Error &&
        error.message.includes('Image size exceeds maximum allowed size')
      ) {
        return res.status(413).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to store image' });
    }
  } else if (req.method === 'GET') {
    // Retrieve image
    const { imageId, sessionId: querySessionId, thumbnail } = req.query;

    if (!imageId || typeof imageId !== 'string') {
      return res.status(400).json({ error: 'Invalid image ID' });
    }

    // Allow retrieving images from other sessions (for cross-device persistence)
    // Use the sessionId from query params if provided, otherwise use current session
    const targetSessionId =
      typeof querySessionId === 'string' && querySessionId
        ? querySessionId
        : sessionId;

    const wantThumbnail = thumbnail === 'true' || thumbnail === '1';

    try {
      const image = await getImage(targetSessionId, imageId, userId);

      if (!image) {
        return res.status(404).json({ error: 'Image not found' });
      }

      if (!canAccessStoredImage(image, sessionId, userId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      // Determine which version to return
      const useThumbnail = wantThumbnail && image.thumbnail;
      const imageData = useThumbnail ? image.thumbnail! : image.data;
      const imageMimeType = useThumbnail
        ? image.thumbnailMimeType || 'image/jpeg'
        : image.mimeType;

      // Return image data with aggressive caching
      res.setHeader('Content-Type', imageMimeType);
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable'); // 24 hours
      res.setHeader('ETag', `"${imageId}${useThumbnail ? '-thumb' : ''}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');

      // Add headers to indicate thumbnail availability and image dimensions
      if (image.thumbnail) {
        res.setHeader('X-Has-Thumbnail', 'true');
      }
      if (image.width && image.height) {
        res.setHeader('X-Image-Width', image.width.toString());
        res.setHeader('X-Image-Height', image.height.toString());
      }

      const buffer = Buffer.from(imageData, 'base64');
      return res.status(200).send(buffer);
    } catch (error) {
      console.error('Error retrieving image:', error);
      return res.status(500).json({ error: 'Failed to retrieve image' });
    }
  } else if (req.method === 'DELETE') {
    // Delete image
    const { imageId } = req.query;

    if (!imageId || typeof imageId !== 'string') {
      return res.status(400).json({ error: 'Invalid image ID' });
    }

    try {
      const deleted = await deleteImage(sessionId, imageId, userId);

      if (!deleted) {
        return res.status(404).json({ error: 'Image not found' });
      }

      return res.status(200).json({ message: 'Image deleted successfully' });
    } catch (error) {
      console.error('Error deleting image:', error);
      return res.status(500).json({ error: 'Failed to delete image' });
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
}

function canAccessStoredImage(
  image: StoredImage,
  currentSessionId: string,
  currentUserId: string,
): boolean {
  if (image.userId) {
    return image.userId === currentUserId;
  }
  return image.sessionId === currentSessionId;
}
