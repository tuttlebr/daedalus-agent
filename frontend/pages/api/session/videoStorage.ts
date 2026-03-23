import { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey, jsonGet, jsonDel, jsonSetWithExpiry } from './redis';
import { getUserId, getOrSetSessionId } from './_utils';
import { validateVideoMagicBytes } from '@/utils/app/magicBytes';
import crypto from 'crypto';

const VIDEO_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB limit

// Supported video formats (from image_comprehension_function.py)
// Codecs: H264, H265, VP8, VP9, FLV
// Formats: MP4, FLV, 3GP
const SUPPORTED_MIME_TYPES = ['video/mp4', 'video/x-flv', 'video/3gpp'];

export interface StoredVideo {
  id: string;
  data: string;
  mimeType: string;
  size: number;
  filename?: string;
  createdAt: number;
  sessionId: string;
  userId?: string;
}

// Generate a unique ID for the video
function generateVideoId(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Validate video mime type
function isValidMimeType(mimeType: string): boolean {
  return SUPPORTED_MIME_TYPES.includes(mimeType.toLowerCase());
}

// Store video in Redis
export async function storeVideo(
  sessionId: string,
  userId: string | undefined,
  base64Data: string,
  filename: string,
  mimeType: string = 'video/mp4'
): Promise<string> {
  const redis = getRedis();
  const videoId = generateVideoId();

  // Remove data URL prefix if present
  const cleanBase64 = base64Data.replace(/^data:video\/[a-z0-9-]+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');
  const size = buffer.length;

  if (size > MAX_VIDEO_SIZE) {
    throw new Error(`Video size (${Math.round(size / (1024 * 1024))}MB) exceeds maximum allowed size (${MAX_VIDEO_SIZE / (1024 * 1024)}MB)`);
  }

  // Validate magic bytes
  if (!validateVideoMagicBytes(buffer)) {
    throw new Error('File content does not appear to be a valid video');
  }

  // Normalize mime type
  let normalizedMimeType = mimeType.toLowerCase();
  if (!isValidMimeType(normalizedMimeType)) {
    // Try to infer from filename
    const ext = filename.toLowerCase().split('.').pop();
    switch (ext) {
      case 'mp4':
        normalizedMimeType = 'video/mp4';
        break;
      case 'flv':
        normalizedMimeType = 'video/x-flv';
        break;
      case '3gp':
        normalizedMimeType = 'video/3gpp';
        break;
      default:
        normalizedMimeType = 'video/mp4'; // Default to mp4
    }
  }

  const videoData: StoredVideo = {
    id: videoId,
    data: cleanBase64,
    mimeType: normalizedMimeType,
    size,
    filename,
    createdAt: Date.now(),
    sessionId,
    userId
  };

  // Use user-specific key for authenticated users, session-specific for anonymous
  const key = userId
    ? sessionKey(['user', userId, 'video', videoId])
    : sessionKey(['video', sessionId, videoId]);

  await jsonSetWithExpiry(key, videoData, VIDEO_EXPIRY_SECONDS);

  // Also store a reference for easy cleanup
  if (userId) {
    const userVideosKey = sessionKey(['user', userId, 'videos']);
    await redis.sadd(userVideosKey, videoId);
    await redis.expire(userVideosKey, VIDEO_EXPIRY_SECONDS);
  } else {
    const sessionVideosKey = sessionKey(['session-videos', sessionId]);
    await redis.sadd(sessionVideosKey, videoId);
    await redis.expire(sessionVideosKey, VIDEO_EXPIRY_SECONDS);
  }

  return videoId;
}

// Retrieve video from Redis
export async function getVideo(
  sessionId: string,
  videoId: string,
  userId?: string
): Promise<StoredVideo | null> {
  // Try user-specific key first if userId is provided
  if (userId) {
    const userKey = sessionKey(['user', userId, 'video', videoId]);
    const userVideo = await jsonGet(userKey) as StoredVideo | null;
    if (userVideo) {
      return userVideo;
    }
  }

  // Fall back to session-specific key
  const key = sessionKey(['video', sessionId, videoId]);
  return await jsonGet(key) as StoredVideo | null;
}

// Delete video from Redis
export async function deleteVideo(
  sessionId: string,
  videoId: string,
  userId?: string
): Promise<boolean> {
  const redis = getRedis();
  let result = 0;

  // Try to delete from user-specific key if userId is provided
  if (userId) {
    const userKey = sessionKey(['user', userId, 'video', videoId]);
    result = await jsonDel(userKey);

    if (result > 0) {
      const userVideosKey = sessionKey(['user', userId, 'videos']);
      await redis.srem(userVideosKey, videoId);
    }
  }

  // Also try session-specific key
  if (result === 0) {
    const key = sessionKey(['video', sessionId, videoId]);
    result = await jsonDel(key);

    const sessionVideosKey = sessionKey(['session-videos', sessionId]);
    await redis.srem(sessionVideosKey, videoId);
  }

  return result > 0;
}

// Get all videos for a session
export async function getSessionVideos(sessionId: string): Promise<string[]> {
  const redis = getRedis();
  const sessionVideosKey = sessionKey(['session-videos', sessionId]);
  return await redis.smembers(sessionVideosKey);
}

// Get all videos for a user
export async function getUserVideos(userId: string): Promise<string[]> {
  const redis = getRedis();
  const userVideosKey = sessionKey(['user', userId, 'videos']);
  return await redis.smembers(userVideosKey);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const sessionId = getOrSetSessionId(req, res);
  const userId = await getUserId(req, res);

  if (req.method === 'POST') {
    // Store video
    try {
      const { base64Data, filename, mimeType } = req.body;

      if (!base64Data) {
        return res.status(400).json({ error: 'No video data provided' });
      }

      if (!filename) {
        return res.status(400).json({ error: 'No filename provided' });
      }

      const videoId = await storeVideo(sessionId, userId, base64Data, filename, mimeType);

      return res.status(200).json({ videoId, sessionId, userId });
    } catch (error) {
      console.error('Error storing video:', error);
      const message = error instanceof Error ? error.message : 'Failed to store video';
      return res.status(500).json({ error: message });
    }
  } else if (req.method === 'GET') {
    // Retrieve video
    const { videoId, sessionId: querySessionId } = req.query;

    if (!videoId || typeof videoId !== 'string') {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    const targetSessionId = (typeof querySessionId === 'string' && querySessionId)
      ? querySessionId
      : sessionId;

    try {
      const video = await getVideo(targetSessionId, videoId, userId);

      if (!video) {
        return res.status(404).json({ error: 'Video not found' });
      }

      // Return video data with caching
      res.setHeader('Content-Type', video.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
      res.setHeader('ETag', `"${videoId}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (video.filename) {
        res.setHeader('Content-Disposition', `inline; filename="${video.filename}"`);
      }

      const buffer = Buffer.from(video.data, 'base64');
      return res.status(200).send(buffer);
    } catch (error) {
      console.error('Error retrieving video:', error);
      return res.status(500).json({ error: 'Failed to retrieve video' });
    }
  } else if (req.method === 'DELETE') {
    // Delete video
    const { videoId } = req.query;

    if (!videoId || typeof videoId !== 'string') {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    try {
      const deleted = await deleteVideo(sessionId, videoId, userId);

      if (!deleted) {
        return res.status(404).json({ error: 'Video not found' });
      }

      return res.status(200).json({ message: 'Video deleted successfully' });
    } catch (error) {
      console.error('Error deleting video:', error);
      return res.status(500).json({ error: 'Failed to delete video' });
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
}

// Configure API route to handle larger payloads
// Note: Set to 150mb to support 100MB videos (base64 encoding adds ~33% overhead)
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '150mb',
    },
  },
};
