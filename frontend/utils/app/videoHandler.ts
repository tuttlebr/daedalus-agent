import { Message } from '@/types/chat';

export interface VideoReference {
  videoId: string;
  sessionId: string;
  userId?: string;
  mimeType?: string;
  filename?: string;
  url?: string;
}

// Supported video formats (from image_comprehension_function.py)
// Codecs: H264, H265, VP8, VP9, FLV
// Formats: MP4, FLV, 3GP
export const SUPPORTED_VIDEO_FORMATS = ['video/mp4', 'video/x-flv', 'video/3gpp'];
export const SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.flv', '.3gp'];
export const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB limit for videos

/**
 * Check if a file is a supported video format
 */
export function isVideoFile(file: File): boolean {
  const mimeType = file.type.toLowerCase();
  const fileName = file.name.toLowerCase();

  // Check MIME type
  if (SUPPORTED_VIDEO_FORMATS.includes(mimeType)) {
    return true;
  }

  // Also check by extension as a fallback
  return SUPPORTED_VIDEO_EXTENSIONS.some(ext => fileName.endsWith(ext));
}

/**
 * Get the MIME type for a video file
 */
export function getVideoMimeType(file: File): string {
  if (file.type && SUPPORTED_VIDEO_FORMATS.includes(file.type.toLowerCase())) {
    return file.type;
  }

  const fileName = file.name.toLowerCase();
  if (fileName.endsWith('.mp4')) return 'video/mp4';
  if (fileName.endsWith('.flv')) return 'video/x-flv';
  if (fileName.endsWith('.3gp')) return 'video/3gpp';

  // Default to mp4
  return 'video/mp4';
}

/**
 * Upload video to Redis and return reference
 */
export async function uploadVideo(
  base64Data: string,
  filename: string,
  mimeType: string = 'video/mp4'
): Promise<VideoReference> {
  try {
    const response = await fetch('/api/session/videoStorage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ base64Data, filename, mimeType }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Failed to upload video');
    }

    const { videoId, sessionId, userId } = await response.json();
    return { videoId, sessionId, userId, filename, mimeType };
  } catch (error) {
    console.error('Error uploading video:', error);
    throw error;
  }
}

/**
 * Get video URL from reference
 */
export function getVideoUrl(videoRef: VideoReference): string {
  // Server-side: need full URL for fetch
  if (typeof window === 'undefined') {
    const port = process.env.PORT || '3000';
    const baseUrl = `http://127.0.0.1:${port}`;
    let url = `${baseUrl}/api/session/videoStorage?videoId=${videoRef.videoId}`;
    if (videoRef.sessionId) {
      url += `&sessionId=${videoRef.sessionId}`;
    }
    return url;
  }

  // Client-side: use relative URL
  let url = `/api/session/videoStorage?videoId=${videoRef.videoId}`;
  if (videoRef.sessionId) {
    url += `&sessionId=${videoRef.sessionId}`;
  }

  return url;
}

/**
 * Delete video from storage
 */
export async function deleteVideo(videoId: string): Promise<void> {
  try {
    const response = await fetch(`/api/session/videoStorage?videoId=${videoId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error('Failed to delete video');
    }
  } catch (error) {
    console.error('Error deleting video:', error);
    throw error;
  }
}

/**
 * Validate video file before upload
 */
export function validateVideoFile(file: File): { valid: boolean; error?: string } {
  // Check if it's a video file
  if (!isVideoFile(file)) {
    return {
      valid: false,
      error: `Unsupported video format. Supported formats: MP4, FLV, 3GP`,
    };
  }

  // Check file size
  if (file.size > MAX_VIDEO_SIZE) {
    return {
      valid: false,
      error: `Video size exceeds maximum allowed (${MAX_VIDEO_SIZE / (1024 * 1024)}MB)`,
    };
  }

  return { valid: true };
}
