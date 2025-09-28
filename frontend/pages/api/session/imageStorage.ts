import { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey } from './redis';
import { getUserId, getOrSetSessionId } from './_utils';
import crypto from 'crypto';

const IMAGE_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB limit

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

// Store image in Redis
export async function storeImage(
  sessionId: string,
  userId: string | undefined,
  base64Data: string,
  mimeType: string = 'image/jpeg'
): Promise<string> {
  const redis = getRedis();
  const imageId = generateImageId();

  // Remove data URL prefix if present
  const cleanBase64 = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
  const size = Buffer.from(cleanBase64, 'base64').length;

  if (size > MAX_IMAGE_SIZE) {
    throw new Error('Image size exceeds maximum allowed size');
  }

  const imageData: StoredImage = {
    id: imageId,
    data: cleanBase64,
    mimeType,
    size,
    createdAt: Date.now(),
    sessionId,
    userId
  };

  const key = sessionKey(['image', sessionId, imageId]);
  await redis.setex(key, IMAGE_EXPIRY_SECONDS, JSON.stringify(imageData));

  // Also store a reference in a session-specific set for easy cleanup
  const sessionImagesKey = sessionKey(['session-images', sessionId]);
  await redis.sadd(sessionImagesKey, imageId);
  await redis.expire(sessionImagesKey, IMAGE_EXPIRY_SECONDS);

  return imageId;
}

// Retrieve image from Redis
export async function getImage(
  sessionId: string,
  imageId: string
): Promise<StoredImage | null> {
  const redis = getRedis();
  const key = sessionKey(['image', sessionId, imageId]);

  const data = await redis.get(key);
  if (!data) return null;

  return JSON.parse(data) as StoredImage;
}

// Delete image from Redis
export async function deleteImage(
  sessionId: string,
  imageId: string
): Promise<boolean> {
  const redis = getRedis();
  const key = sessionKey(['image', sessionId, imageId]);

  const result = await redis.del(key);

  // Remove from session images set
  const sessionImagesKey = sessionKey(['session-images', sessionId]);
  await redis.srem(sessionImagesKey, imageId);

  return result > 0;
}

// Get all images for a session
export async function getSessionImages(sessionId: string): Promise<string[]> {
  const redis = getRedis();
  const sessionImagesKey = sessionKey(['session-images', sessionId]);

  return await redis.smembers(sessionImagesKey);
}

// Clean up all images for a session
export async function cleanupSessionImages(sessionId: string): Promise<number> {
  const redis = getRedis();
  const imageIds = await getSessionImages(sessionId);

  let deletedCount = 0;
  for (const imageId of imageIds) {
    const deleted = await deleteImage(sessionId, imageId);
    if (deleted) deletedCount++;
  }

  // Delete the session images set
  const sessionImagesKey = sessionKey(['session-images', sessionId]);
  await redis.del(sessionImagesKey);

  return deletedCount;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const sessionId = getOrSetSessionId(req, res);
  const userId = getUserId(req);

  if (req.method === 'POST') {
    // Store image
    try {
      const { base64Data, mimeType } = req.body;

      if (!base64Data) {
        return res.status(400).json({ error: 'No image data provided' });
      }

      const imageId = await storeImage(sessionId, userId, base64Data, mimeType);

      return res.status(200).json({ imageId, sessionId });
    } catch (error) {
      console.error('Error storing image:', error);
      return res.status(500).json({ error: 'Failed to store image' });
    }
  } else if (req.method === 'GET') {
    // Retrieve image
    const { imageId } = req.query;

    if (!imageId || typeof imageId !== 'string') {
      return res.status(400).json({ error: 'Invalid image ID' });
    }

    try {
      const image = await getImage(sessionId, imageId);

      if (!image) {
        return res.status(404).json({ error: 'Image not found' });
      }

      // Return image data
      res.setHeader('Content-Type', image.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=3600');

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
      const deleted = await deleteImage(sessionId, imageId);

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
