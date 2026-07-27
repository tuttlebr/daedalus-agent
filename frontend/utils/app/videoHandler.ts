export interface VideoReference {
  videoId: string;
  sessionId: string;
  userId?: string;
  mimeType?: string;
  filename?: string;
  url?: string;
}

// Supported video formats (from visual_media_function.py analyze path)
// Codecs: H264, H265, VP8, VP9, FLV
// Formats: MP4, FLV, 3GP
const SUPPORTED_VIDEO_FORMATS = ['video/mp4', 'video/x-flv', 'video/3gpp'];

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
  mimeType: string = 'video/mp4',
  signal?: AbortSignal,
): Promise<VideoReference> {
  try {
    const response = await fetch('/api/session/videoStorage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      signal,
      body: JSON.stringify({ base64Data, filename, mimeType }),
    });

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Failed to upload video');
    }

    const { videoId, sessionId, userId } = await response.json();
    return { videoId, sessionId, userId, filename, mimeType };
  } catch (error) {
    console.error('Error uploading video:', error);
    throw error;
  }
}
