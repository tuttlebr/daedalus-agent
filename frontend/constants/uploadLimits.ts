/**
 * Centralized upload limits for file uploads.
 *
 * IMPORTANT: These limits account for base64 encoding overhead.
 * Base64 encoding increases file size by ~33%, so client-side limits
 * should be ~75% of server-side limits to ensure uploads don't fail.
 *
 * Default raw limits before base64 overhead:
 * - Image: 100MB
 * - Video: 100MB
 * - Document: 200MB
 */

const MB = 1024 * 1024;
const KB = 1024;

const ENV = {
  NEXT_PUBLIC_UPLOAD_BASE64_OVERHEAD_FACTOR:
    process.env.NEXT_PUBLIC_UPLOAD_BASE64_OVERHEAD_FACTOR,
  NEXT_PUBLIC_UPLOAD_IMAGE_SERVER_LIMIT_MB:
    process.env.NEXT_PUBLIC_UPLOAD_IMAGE_SERVER_LIMIT_MB,
  NEXT_PUBLIC_UPLOAD_VIDEO_SERVER_LIMIT_MB:
    process.env.NEXT_PUBLIC_UPLOAD_VIDEO_SERVER_LIMIT_MB,
  NEXT_PUBLIC_UPLOAD_DOCUMENT_SERVER_LIMIT_MB:
    process.env.NEXT_PUBLIC_UPLOAD_DOCUMENT_SERVER_LIMIT_MB,
  NEXT_PUBLIC_UPLOAD_TRANSCRIPT_MAX_MB:
    process.env.NEXT_PUBLIC_UPLOAD_TRANSCRIPT_MAX_MB,
  NEXT_PUBLIC_UPLOAD_MAX_IMAGES_PER_BATCH:
    process.env.NEXT_PUBLIC_UPLOAD_MAX_IMAGES_PER_BATCH,
  NEXT_PUBLIC_UPLOAD_MAX_DOCUMENTS_PER_BATCH:
    process.env.NEXT_PUBLIC_UPLOAD_MAX_DOCUMENTS_PER_BATCH,
  NEXT_PUBLIC_UPLOAD_MAX_VIDEOS_PER_BATCH:
    process.env.NEXT_PUBLIC_UPLOAD_MAX_VIDEOS_PER_BATCH,
  NEXT_PUBLIC_UPLOAD_IMAGE_COMPRESSION_THRESHOLD_KB:
    process.env.NEXT_PUBLIC_UPLOAD_IMAGE_COMPRESSION_THRESHOLD_KB,
  NEXT_PUBLIC_UPLOAD_MAX_EXTRACTED_TEXT_CHARS:
    process.env.NEXT_PUBLIC_UPLOAD_MAX_EXTRACTED_TEXT_CHARS,
  NEXT_PUBLIC_UPLOAD_LARGE_DOCUMENT_THRESHOLD_KB:
    process.env.NEXT_PUBLIC_UPLOAD_LARGE_DOCUMENT_THRESHOLD_KB,
} as const;

type EnvName = keyof typeof ENV;

function positiveNumberFromEnv(names: EnvName[], fallback: number): number {
  for (const name of names) {
    const raw = ENV[name];
    if (raw === undefined || raw.trim() === '') continue;

    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}

function positiveIntegerFromEnv(names: EnvName[], fallback: number): number {
  return Math.floor(positiveNumberFromEnv(names, fallback));
}

function mbToBytes(mb: number): number {
  return Math.floor(mb * MB);
}

function kbToBytes(kb: number): number {
  return Math.floor(kb * KB);
}

function bytesToDisplayMb(bytes: number): number {
  return Math.floor(bytes / MB);
}

// Base64 encoding increases size by ~33% (4/3 ratio). To ensure encoded data
// fits within server limits, the default client-side file size is 75% of the
// configured raw server-side limit.
const BASE64_OVERHEAD_FACTOR = positiveNumberFromEnv(
  ['NEXT_PUBLIC_UPLOAD_BASE64_OVERHEAD_FACTOR'],
  0.75,
);

// Server-side limits (raw)
const SERVER_IMAGE_LIMIT = mbToBytes(
  positiveNumberFromEnv(['NEXT_PUBLIC_UPLOAD_IMAGE_SERVER_LIMIT_MB'], 100),
);
const SERVER_VIDEO_LIMIT = mbToBytes(
  positiveNumberFromEnv(['NEXT_PUBLIC_UPLOAD_VIDEO_SERVER_LIMIT_MB'], 100),
);
const SERVER_DOCUMENT_LIMIT = mbToBytes(
  positiveNumberFromEnv(['NEXT_PUBLIC_UPLOAD_DOCUMENT_SERVER_LIMIT_MB'], 200),
);

const IMAGE_MAX_SIZE_BYTES = Math.floor(
  SERVER_IMAGE_LIMIT * BASE64_OVERHEAD_FACTOR,
);
const VIDEO_MAX_SIZE_BYTES = Math.floor(
  SERVER_VIDEO_LIMIT * BASE64_OVERHEAD_FACTOR,
);
const DOCUMENT_MAX_SIZE_BYTES = Math.floor(
  SERVER_DOCUMENT_LIMIT * BASE64_OVERHEAD_FACTOR,
);
const TRANSCRIPT_MAX_SIZE_BYTES = mbToBytes(
  positiveNumberFromEnv(['NEXT_PUBLIC_UPLOAD_TRANSCRIPT_MAX_MB'], 50),
);

/**
 * Client-side upload limits in bytes.
 * These are conservative to account for base64 encoding overhead.
 */
export const UPLOAD_LIMITS = {
  // Image limits
  IMAGE_MAX_SIZE_BYTES,
  IMAGE_MAX_SIZE_MB: bytesToDisplayMb(IMAGE_MAX_SIZE_BYTES),

  // Video limits
  VIDEO_MAX_SIZE_BYTES,
  VIDEO_MAX_SIZE_MB: bytesToDisplayMb(VIDEO_MAX_SIZE_BYTES),

  // Document limits (PDF, DOCX, PPTX, HTML, Markdown, plain text, etc.)
  DOCUMENT_MAX_SIZE_BYTES,
  DOCUMENT_MAX_SIZE_MB: bytesToDisplayMb(DOCUMENT_MAX_SIZE_BYTES),
  DOCUMENT_SERVER_LIMIT_BYTES: SERVER_DOCUMENT_LIMIT,
  DOCUMENT_SERVER_MAX_BASE64_CHARS: maxBase64EncodedLength(
    SERVER_DOCUMENT_LIMIT,
  ),

  // Transcript limits (VTT, SRT - text files, smaller limit)
  TRANSCRIPT_MAX_SIZE_BYTES,
  TRANSCRIPT_MAX_SIZE_MB: bytesToDisplayMb(TRANSCRIPT_MAX_SIZE_BYTES),

  // Batch limits
  MAX_IMAGES_PER_BATCH: positiveIntegerFromEnv(
    ['NEXT_PUBLIC_UPLOAD_MAX_IMAGES_PER_BATCH'],
    15,
  ),
  MAX_DOCUMENTS_PER_BATCH: positiveIntegerFromEnv(
    ['NEXT_PUBLIC_UPLOAD_MAX_DOCUMENTS_PER_BATCH'],
    500,
  ),
  MAX_VIDEOS_PER_BATCH: positiveIntegerFromEnv(
    ['NEXT_PUBLIC_UPLOAD_MAX_VIDEOS_PER_BATCH'],
    1,
  ),

  // Compression thresholds
  IMAGE_COMPRESSION_THRESHOLD_KB: positiveIntegerFromEnv(
    ['NEXT_PUBLIC_UPLOAD_IMAGE_COMPRESSION_THRESHOLD_KB'],
    2000,
  ),

  // Document text extraction limits
  MAX_EXTRACTED_TEXT_CHARS: positiveIntegerFromEnv(
    ['NEXT_PUBLIC_UPLOAD_MAX_EXTRACTED_TEXT_CHARS'],
    128000,
  ),
  LARGE_DOCUMENT_THRESHOLD_BYTES: kbToBytes(
    positiveNumberFromEnv(
      ['NEXT_PUBLIC_UPLOAD_LARGE_DOCUMENT_THRESHOLD_KB'],
      640,
    ),
  ),
} as const;

/** Maximum number of base64 characters needed to represent a byte limit. */
export function maxBase64EncodedLength(rawByteLimit: number): number {
  return Math.ceil(rawByteLimit / 3) * 4;
}

/**
 * Return the encoded payload length without allocating a second full string.
 * Data URLs produced by FileReader have a short metadata prefix before the
 * comma; plain base64 values are also accepted by the upload API.
 */
export function base64PayloadLength(value: string): number {
  if (!value.startsWith('data:')) return value.length;
  const separator = value.indexOf(',');
  return separator === -1 ? value.length : value.length - separator - 1;
}

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
  type: 'image' | 'video' | 'document' | 'transcript',
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
      error: `File size (${formatFileSize(
        file.size,
      )}) exceeds maximum allowed size (${formatFileSize(maxSize)})`,
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
  if (
    type.startsWith('video/') ||
    name.endsWith('.mp4') ||
    name.endsWith('.flv') ||
    name.endsWith('.3gp')
  ) {
    return UPLOAD_LIMITS.VIDEO_MAX_SIZE_BYTES;
  }

  // Check for transcript files (VTT, SRT)
  if (type === 'text/vtt' || name.endsWith('.vtt') || name.endsWith('.srt')) {
    return UPLOAD_LIMITS.TRANSCRIPT_MAX_SIZE_BYTES;
  }

  // Check for document
  if (
    type === 'application/pdf' ||
    type ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    type ===
      'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    type === 'text/html' ||
    type === 'text/markdown' ||
    type === 'text/x-markdown' ||
    type === 'text/plain' ||
    name.endsWith('.pdf') ||
    name.endsWith('.docx') ||
    name.endsWith('.pptx') ||
    name.endsWith('.html') ||
    name.endsWith('.htm') ||
    name.endsWith('.md') ||
    name.endsWith('.markdown') ||
    name.endsWith('.txt')
  ) {
    return UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES;
  }

  // Default to image limit
  return UPLOAD_LIMITS.IMAGE_MAX_SIZE_BYTES;
}

/**
 * Estimate base64 encoded size from raw file size
 */
export function estimateBase64Size(rawSize: number): number {
  return Math.ceil((rawSize * 4) / 3);
}

/**
 * Check if a file will likely exceed server limits after base64 encoding
 */
export function willExceedServerLimit(
  file: File,
  serverLimit: number,
): boolean {
  return estimateBase64Size(file.size) > serverLimit;
}
