/**
 * Centralized upload limits for file uploads.
 *
 * Image and document limits are expressed as the actual uploaded file size.
 * The image route reserves base64/JSON overhead separately in its parser and
 * proxy limits. Video retains its legacy client-side overhead reservation.
 *
 * Default raw limits:
 * - Image: 30MB
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

// Base64 encoding increases size by ~33% (4/3 ratio). The legacy video route
// still uses this client-side reservation. The image route has a dedicated
// parser/proxy ceiling, so its public limit remains the actual raw file size.
const BASE64_OVERHEAD_FACTOR = positiveNumberFromEnv(
  ['NEXT_PUBLIC_UPLOAD_BASE64_OVERHEAD_FACTOR'],
  0.75,
);

// Server-side limits (raw)
// imageStorage has a fixed 30 MiB decoded-image ceiling. Never let a public
// build-time override advertise more than that route can accept.
const IMAGE_ROUTE_RAW_LIMIT = 30 * MB;
const SERVER_IMAGE_LIMIT = Math.min(
  mbToBytes(
    positiveNumberFromEnv(['NEXT_PUBLIC_UPLOAD_IMAGE_SERVER_LIMIT_MB'], 30),
  ),
  IMAGE_ROUTE_RAW_LIMIT,
);
const SERVER_VIDEO_LIMIT = mbToBytes(
  positiveNumberFromEnv(['NEXT_PUBLIC_UPLOAD_VIDEO_SERVER_LIMIT_MB'], 100),
);
const SERVER_DOCUMENT_LIMIT = mbToBytes(
  positiveNumberFromEnv(['NEXT_PUBLIC_UPLOAD_DOCUMENT_SERVER_LIMIT_MB'], 200),
);
const IMAGE_MAX_SIZE_BYTES = SERVER_IMAGE_LIMIT;
const VIDEO_MAX_SIZE_BYTES = Math.floor(
  SERVER_VIDEO_LIMIT * BASE64_OVERHEAD_FACTOR,
);
const DOCUMENT_MAX_SIZE_BYTES = SERVER_DOCUMENT_LIMIT;

/**
 * Client-side upload limits in bytes.
 * Image values are raw file sizes; the image route accounts for JSON/base64
 * framing independently. Video remains conservative for its legacy transport.
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

  // Batch limits
  MAX_IMAGES_PER_BATCH: positiveIntegerFromEnv(
    ['NEXT_PUBLIC_UPLOAD_MAX_IMAGES_PER_BATCH'],
    15,
  ),
  MAX_DOCUMENTS_PER_BATCH: positiveIntegerFromEnv(
    ['NEXT_PUBLIC_UPLOAD_MAX_DOCUMENTS_PER_BATCH'],
    20,
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
  type: 'image' | 'video' | 'document',
): { valid: boolean; error?: string } {
  const limits = {
    image: UPLOAD_LIMITS.IMAGE_MAX_SIZE_BYTES,
    video: UPLOAD_LIMITS.VIDEO_MAX_SIZE_BYTES,
    document: UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES,
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
