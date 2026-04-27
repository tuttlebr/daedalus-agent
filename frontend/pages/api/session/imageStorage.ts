import { NextApiRequest, NextApiResponse } from 'next';

import { getUserId, getOrSetSessionId } from './_utils';
import {
  getRedis,
  sessionKey,
  jsonGet,
  jsonDel,
  jsonSetWithExpiry,
} from './redis';

import crypto from 'crypto';
import sharp from 'sharp';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

const IMAGE_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB limit
const THUMBNAIL_MAX_SIZE = 400; // Max dimension for thumbnails
const THUMBNAIL_QUALITY = 80; // JPEG quality for thumbnails

export interface StoredImage {
  id: string;
  data: string;
  mimeType: string;
  size: number;
  createdAt: number;
  sessionId: string;
  userId?: string;
  thumbnail?: string; // Base64 thumbnail data
  thumbnailMimeType?: string;
  width?: number;
  height?: number;
}

// Generate a unique ID for the image
function generateImageId(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Process image preserving original format (no lossy compression) and generate thumbnail
async function processImage(
  base64Data: string,
  mimeType: string,
): Promise<{
  data: string;
  mimeType: string;
  size: number;
  thumbnail?: string;
  thumbnailMimeType?: string;
  width?: number;
  height?: number;
}> {
  // Remove data URL prefix if present
  const cleanBase64 = base64Data.replace(/^data:image\/[a-z+]+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');

  try {
    // Use sharp to validate the image and get metadata
    const sharpInstance = sharp(buffer);
    const metadata = await sharpInstance.metadata();

    // Determine the correct MIME type based on actual image format
    let actualMimeType = mimeType;
    if (metadata.format) {
      const formatToMime: Record<string, string> = {
        png: 'image/png',
        jpeg: 'image/jpeg',
        jpg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        avif: 'image/avif',
      };
      actualMimeType = formatToMime[metadata.format] || mimeType;
    }

    // Generate thumbnail if image is larger than thumbnail size
    let thumbnail: string | undefined;
    let thumbnailMimeType: string | undefined;
    const width = metadata.width || 0;
    const height = metadata.height || 0;

    if (width > THUMBNAIL_MAX_SIZE || height > THUMBNAIL_MAX_SIZE) {
      try {
        const thumbnailBuffer = await sharp(buffer)
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

    // For PNG images, keep them as PNG (lossless)
    // For other formats, preserve them as-is without re-encoding
    // This preserves original quality without lossy compression
    return {
      data: cleanBase64,
      mimeType: actualMimeType,
      size: buffer.length,
      thumbnail,
      thumbnailMimeType,
      width,
      height,
    };
  } catch (error) {
    console.error('Image processing failed, using original:', error);
    // Return original if processing fails
    return {
      data: cleanBase64,
      mimeType,
      size: buffer.length,
    };
  }
}

// Store image in Redis
export async function storeImage(
  sessionId: string,
  userId: string | undefined,
  base64Data: string,
  mimeType: string = 'image/png',
): Promise<string> {
  const redis = getRedis();
  const imageId = generateImageId();

  // Process image while preserving original format (no lossy compression)
  const processed = await processImage(base64Data, mimeType);

  if (processed.size > MAX_IMAGE_SIZE) {
    throw new Error('Image size exceeds maximum allowed size');
  }

  const imageData: StoredImage = {
    id: imageId,
    data: processed.data,
    mimeType: processed.mimeType,
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

  return imageId;
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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const sessionId = getOrSetSessionId(req, res);
  const userId = await getUserId(req, res);

  if (req.method === 'POST') {
    // Store image
    try {
      const { base64Data, mimeType } = req.body;

      if (!base64Data) {
        return res.status(400).json({ error: 'No image data provided' });
      }

      const imageId = await storeImage(sessionId, userId, base64Data, mimeType);

      return res.status(200).json({ imageId, sessionId, userId });
    } catch (error) {
      console.error('Error storing image:', error);
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
