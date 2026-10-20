import { NextApiRequest, NextApiResponse } from 'next';

import { validateVideoMagicBytes } from '@/utils/app/magicBytes';

import { enforceRateLimit, ruleFromEnv } from '@/server/rateLimit';
import {
  getStorageSessionId,
  requireAuthenticatedUser,
} from '@/server/session/_utils';
import { sessionKey, jsonSetWithExpiry } from '@/server/session/redis';
import crypto from 'crypto';

const VIDEO_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB limit
const MAX_FILENAME_CHARS = 512;

// Supported video formats (from visual_media_function.py analyze path)
// Codecs: H264, H265, VP8, VP9, FLV
// Formats: MP4, FLV, 3GP
const SUPPORTED_MIME_TYPES = ['video/mp4', 'video/x-flv', 'video/3gpp'];
const VIDEO_SIZE_ERROR = 'exceeds maximum allowed size';
const VIDEO_TYPE_ERROR = 'File content does not appear to be a valid video';

export interface StoredVideo {
  id: string;
  data: string;
  mimeType: string;
  size: number;
  filename?: string;
  createdAt: number;
  sessionId: string;
  userId: string;
}

// Generate a unique ID for the video
function generateVideoId(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Validate video mime type
function isValidMimeType(mimeType: string): boolean {
  return SUPPORTED_MIME_TYPES.includes(mimeType.toLowerCase());
}

// Store a video for the backend's visual-media tool, which reads
// user:{userId}:video:{videoId} directly. The browser only uploads.
export async function storeVideo(
  sessionId: string,
  userId: string,
  base64Data: string,
  filename: string,
  mimeType: string = 'video/mp4',
): Promise<string> {
  const videoId = generateVideoId();

  // Remove data URL prefix if present
  const cleanBase64 = base64Data.replace(/^data:video\/[a-z0-9-]+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');
  const size = buffer.length;

  if (size > MAX_VIDEO_SIZE) {
    throw new Error(
      `Video size (${Math.round(
        size / (1024 * 1024),
      )}MB) ${VIDEO_SIZE_ERROR} (${MAX_VIDEO_SIZE / (1024 * 1024)}MB)`,
    );
  }

  // Validate magic bytes
  if (!validateVideoMagicBytes(buffer)) {
    throw new Error(VIDEO_TYPE_ERROR);
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
    userId,
  };

  await jsonSetWithExpiry(
    sessionKey(['user', userId, 'video', videoId]),
    videoData,
    VIDEO_EXPIRY_SECONDS,
  );

  return videoId;
}

// Backstop on the (large, single-file) video upload path; caps abusive floods.
const VIDEO_UPLOAD_RATE_LIMIT = ruleFromEnv(
  'video-upload',
  'RATE_LIMIT_VIDEO_UPLOAD',
  60,
  60,
);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  const sessionId = getStorageSessionId(req, res);
  const userId = session.username;

  if (req.method === 'POST') {
    if (!(await enforceRateLimit(res, VIDEO_UPLOAD_RATE_LIMIT, userId))) return;
    // Store video
    try {
      const { base64Data, filename, mimeType } = req.body ?? {};

      if (typeof base64Data !== 'string' || !base64Data) {
        return res.status(400).json({ error: 'No video data provided' });
      }

      if (!filename) {
        return res.status(400).json({ error: 'No filename provided' });
      }
      // Store only well-formed names; the backend tool receives this record.
      if (
        typeof filename !== 'string' ||
        filename.length > MAX_FILENAME_CHARS ||
        /[\u0000-\u001f\u007f]|\p{Cs}/u.test(filename)
      ) {
        return res.status(400).json({ error: 'Invalid filename' });
      }
      if (mimeType !== undefined && typeof mimeType !== 'string') {
        return res.status(400).json({ error: 'Invalid video MIME type' });
      }

      const videoId = await storeVideo(
        sessionId,
        userId,
        base64Data,
        filename,
        mimeType,
      );

      return res.status(200).json({ videoId, sessionId, userId });
    } catch (error) {
      console.error('Error storing video:', error);
      const message = error instanceof Error ? error.message : '';
      // Only the validation messages are written for users; infrastructure
      // diagnostics (Redis, network) are logged above and never echoed.
      if (message.includes(VIDEO_SIZE_ERROR)) {
        return res.status(413).json({ error: message });
      }
      if (message.includes(VIDEO_TYPE_ERROR)) {
        return res.status(415).json({ error: message });
      }
      return res.status(500).json({ error: 'Failed to store video' });
    }
  } else {
    res.setHeader('Allow', ['POST']);
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
