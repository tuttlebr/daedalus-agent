/**
 * Centralized upload limits for file uploads.
 *
 * IMPORTANT: These limits account for base64 encoding overhead.
 * Base64 encoding increases file size by ~33%, so client-side limits
 * should be ~75% of server-side limits to ensure uploads don't fail.
 *
 * Server-side limits (from pages/api/session/*):
 * - Image: 100MB (imageStorage.ts)
 * - Video: 100MB (videoStorage.ts)
 * - Document: 200MB (documentStorage.ts)
 */

// Base64 encoding increases size by ~33% (4/3 ratio)
// To ensure encoded data fits within server limits, we use 75% of server limit
const BASE64_OVERHEAD_FACTOR = 0.75;

// Server-side limits (raw)
const SERVER_IMAGE_LIMIT = 100 * 1024 * 1024;   // 100MB
const SERVER_VIDEO_LIMIT = 100 * 1024 * 1024;  // 100MB
const SERVER_DOCUMENT_LIMIT = 200 * 1024 * 1024;     // 200MB

/**
 * Client-side upload limits in bytes.
 * These are conservative to account for base64 encoding overhead.
 */
export const UPLOAD_LIMITS = {
  // Image limits
  IMAGE_MAX_SIZE_BYTES: Math.floor(SERVER_IMAGE_LIMIT * BASE64_OVERHEAD_FACTOR), // ~75MB
  IMAGE_MAX_SIZE_MB: 75,

  // Video limits
  VIDEO_MAX_SIZE_BYTES: Math.floor(SERVER_VIDEO_LIMIT * BASE64_OVERHEAD_FACTOR), // ~75MB
  VIDEO_MAX_SIZE_MB: 75,

  // Document limits (PDF, DOCX, PPTX, HTML, etc.)
  DOCUMENT_MAX_SIZE_BYTES: Math.floor(SERVER_DOCUMENT_LIMIT * BASE64_OVERHEAD_FACTOR), // ~150MB
  DOCUMENT_MAX_SIZE_MB: 150,

  // Transcript limits (VTT, SRT - text files, smaller limit)
  TRANSCRIPT_MAX_SIZE_BYTES: 50 * 1024 * 1024, // 50MB for text transcripts
  TRANSCRIPT_MAX_SIZE_MB: 50,

  // Batch limits
  MAX_IMAGES_PER_BATCH: 15,
  MAX_DOCUMENTS_PER_BATCH: 100,
  MAX_VIDEOS_PER_BATCH: 1, // Currently only one video at a time

  // Compression thresholds
  IMAGE_COMPRESSION_THRESHOLD_KB: 2000, // Compress images larger than 2000KB

  // Document text extraction limits
  MAX_EXTRACTED_TEXT_CHARS: 128000,
  LARGE_DOCUMENT_THRESHOLD_BYTES: 640 * 1024, // ~640KB - documents likely to need truncation
} as const;

/**
 * Human-readable file size formatting
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validate file size against limits
 */
export function validateFileSize(
  file: File,
  type: 'image' | 'video' | 'document' | 'transcript'
): { valid: boolean; error?: string } {
  const limits = {
    image: UPLOAD_LIMITS.IMAGE_MAX_SIZE_BYTES,
    video: UPLOAD_LIMITS.VIDEO_MAX_SIZE_BYTES,
    document: UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES,
    transcript: UPLOAD_LIMITS.TRANSCRIPT_MAX_SIZE_BYTES,
  };

  const maxSize = limits[type];

  if (file.size > maxSize) {
    return {
      valid: false,
      error: `File size (${formatFileSize(file.size)}) exceeds maximum allowed size (${formatFileSize(maxSize)})`,
    };
  }

  return { valid: true };
}

/**
 * Get the appropriate limit for a file based on its type
 */
export function getFileSizeLimit(file: File): number {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();

  // Check for video
  if (type.startsWith('video/') ||
      name.endsWith('.mp4') ||
      name.endsWith('.flv') ||
      name.endsWith('.3gp')) {
    return UPLOAD_LIMITS.VIDEO_MAX_SIZE_BYTES;
  }

  // Check for transcript files (VTT, SRT)
  if (type === 'text/vtt' ||
      name.endsWith('.vtt') ||
      name.endsWith('.srt')) {
    return UPLOAD_LIMITS.TRANSCRIPT_MAX_SIZE_BYTES;
  }

  // Check for document
  if (type === 'application/pdf' ||
      type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      type === 'text/html' ||
      name.endsWith('.pdf') ||
      name.endsWith('.docx') ||
      name.endsWith('.pptx') ||
      name.endsWith('.html') ||
      name.endsWith('.htm')) {
    return UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES;
  }

  // Default to image limit
  return UPLOAD_LIMITS.IMAGE_MAX_SIZE_BYTES;
}

/**
 * Estimate base64 encoded size from raw file size
 */
export function estimateBase64Size(rawSize: number): number {
  return Math.ceil(rawSize * 4 / 3);
}

/**
 * Check if a file will likely exceed server limits after base64 encoding
 */
export function willExceedServerLimit(
  file: File,
  serverLimit: number
): boolean {
  return estimateBase64Size(file.size) > serverLimit;
}
