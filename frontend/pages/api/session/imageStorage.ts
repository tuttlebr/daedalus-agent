import { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey, jsonGet, jsonDel, jsonSetWithExpiry } from './redis';
import { getUserId, getOrSetSessionId } from './_utils';
import crypto from 'crypto';
import sharp from 'sharp';

const IMAGE_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB limit
const COMPRESS_QUALITY = 80; // JPEG quality for compression

export interface StoredImage {
  id: string;
  data: string;
  mimeType: string;
  size: number;
  createdAt: number;
  sessionId: string;
  userId?: string;
}

// Generate a unique ID for the image
function generateImageId(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Compress image using sharp
async function compressImage(base64Data: string, mimeType: string): Promise<{ data: string; mimeType: string; size: number }> {
  // Remove data URL prefix if present
  const cleanBase64 = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');

  try {
    // Use sharp to compress the image
    let sharpInstance = sharp(buffer);

    // Convert to progressive JPEG/WebP based on original type
    if (mimeType.includes('webp')) {
      const compressed = await sharpInstance
        .webp({ quality: COMPRESS_QUALITY, effort: 4 })
        .toBuffer();

      return {
        data: compressed.toString('base64'),
        mimeType: 'image/webp',
        size: compressed.length
      };
    } else {
      // Default to JPEG for all other formats
      const compressed = await sharpInstance
        .jpeg({ quality: COMPRESS_QUALITY, progressive: true })
        .toBuffer();

      return {
        data: compressed.toString('base64'),
        mimeType: 'image/jpeg',
        size: compressed.length
      };
    }
  } catch (error) {
    console.error('Image compression failed, using original:', error);
    // Return original if compression fails
    return {
      data: cleanBase64,
      mimeType,
      size: buffer.length
    };
  }
}

// Store image in Redis
export async function storeImage(
  sessionId: string,
  userId: string | undefined,
  base64Data: string,
  mimeType: string = 'image/jpeg'
): Promise<string> {
  const redis = getRedis();
  const imageId = generateImageId();

  // Compress the image before storing
  const compressed = await compressImage(base64Data, mimeType);

  if (compressed.size > MAX_IMAGE_SIZE) {
    throw new Error('Image size exceeds maximum allowed size even after compression');
  }

  const imageData: StoredImage = {
    id: imageId,
    data: compressed.data,
    mimeType: compressed.mimeType,
    size: compressed.size,
    createdAt: Date.now(),
    sessionId,
    userId
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
  userId?: string
): Promise<StoredImage | null> {
  // Try user-specific key first if userId is provided
  if (userId) {
    const userKey = sessionKey(['user', userId, 'image', imageId]);
    const userImage = await jsonGet(userKey) as StoredImage | null;
    if (userImage) {
      return userImage;
    }
  }

  // Fall back to session-specific key (for backward compatibility)
  const key = sessionKey(['image', sessionId, imageId]);
  return await jsonGet(key) as StoredImage | null;
}

// Delete image from Redis
export async function deleteImage(
  sessionId: string,
  imageId: string,
  userId?: string
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
export async function cleanupSessionImages(sessionId: string, userId?: string): Promise<number> {
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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
    const { imageId, sessionId: querySessionId } = req.query;

    if (!imageId || typeof imageId !== 'string') {
      return res.status(400).json({ error: 'Invalid image ID' });
    }

    // Allow retrieving images from other sessions (for cross-device persistence)
    // Use the sessionId from query params if provided, otherwise use current session
    const targetSessionId = (typeof querySessionId === 'string' && querySessionId)
      ? querySessionId
      : sessionId;

    try {
      const image = await getImage(targetSessionId, imageId, userId);

      if (!image) {
        return res.status(404).json({ error: 'Image not found' });
      }

      // Return image data with aggressive caching
      res.setHeader('Content-Type', image.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable'); // 24 hours
      res.setHeader('ETag', `"${imageId}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const buffer = Buffer.from(image.data, 'base64');
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
