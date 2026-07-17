import { UPLOAD_LIMITS, getFileSizeLimit } from '@/constants/uploadLimits';
import { describe, expect, it, vi } from 'vitest';

function fileLike(name: string, type: string): File {
  return { name, type } as File;
}

const UPLOAD_ENV_KEYS = [
  'NEXT_PUBLIC_UPLOAD_BASE64_OVERHEAD_FACTOR',
  'NEXT_PUBLIC_UPLOAD_IMAGE_SERVER_LIMIT_MB',
  'NEXT_PUBLIC_UPLOAD_VIDEO_SERVER_LIMIT_MB',
  'NEXT_PUBLIC_UPLOAD_DOCUMENT_SERVER_LIMIT_MB',
  'NEXT_PUBLIC_UPLOAD_TRANSCRIPT_MAX_MB',
  'NEXT_PUBLIC_UPLOAD_MAX_IMAGES_PER_BATCH',
  'NEXT_PUBLIC_UPLOAD_MAX_DOCUMENTS_PER_BATCH',
  'NEXT_PUBLIC_UPLOAD_MAX_VIDEOS_PER_BATCH',
  'NEXT_PUBLIC_UPLOAD_IMAGE_COMPRESSION_THRESHOLD_KB',
  'NEXT_PUBLIC_UPLOAD_MAX_EXTRACTED_TEXT_CHARS',
  'NEXT_PUBLIC_UPLOAD_LARGE_DOCUMENT_THRESHOLD_KB',
];

async function importUploadLimitsWithEnv(env: Record<string, string>) {
  const previous = new Map<string, string | undefined>();
  for (const key of UPLOAD_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, env);

  vi.resetModules();
  try {
    return await import('@/constants/uploadLimits');
  } finally {
    for (const key of UPLOAD_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.resetModules();
  }
}

describe('getFileSizeLimit', () => {
  it('classifies markdown files as documents', () => {
    expect(getFileSizeLimit(fileLike('notes.md', ''))).toBe(
      UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES,
    );
    expect(getFileSizeLimit(fileLike('README.markdown', 'text/markdown'))).toBe(
      UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES,
    );
    expect(getFileSizeLimit(fileLike('notes', 'text/x-markdown'))).toBe(
      UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES,
    );
  });

  it('classifies plain text files as documents', () => {
    expect(getFileSizeLimit(fileLike('notes.txt', ''))).toBe(
      UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES,
    );
    expect(getFileSizeLimit(fileLike('notes', 'text/plain'))).toBe(
      UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES,
    );
  });
});

describe('UPLOAD_LIMITS env overrides', () => {
  it('uses public size and batch settings from env', async () => {
    const { UPLOAD_LIMITS: envLimits } = await importUploadLimitsWithEnv({
      NEXT_PUBLIC_UPLOAD_IMAGE_SERVER_LIMIT_MB: '40',
      NEXT_PUBLIC_UPLOAD_VIDEO_SERVER_LIMIT_MB: '120',
      NEXT_PUBLIC_UPLOAD_DOCUMENT_SERVER_LIMIT_MB: '300',
      NEXT_PUBLIC_UPLOAD_TRANSCRIPT_MAX_MB: '12',
      NEXT_PUBLIC_UPLOAD_MAX_IMAGES_PER_BATCH: '4',
      NEXT_PUBLIC_UPLOAD_MAX_DOCUMENTS_PER_BATCH: '250',
      NEXT_PUBLIC_UPLOAD_MAX_VIDEOS_PER_BATCH: '2',
      NEXT_PUBLIC_UPLOAD_IMAGE_COMPRESSION_THRESHOLD_KB: '512',
      NEXT_PUBLIC_UPLOAD_MAX_EXTRACTED_TEXT_CHARS: '64000',
      NEXT_PUBLIC_UPLOAD_LARGE_DOCUMENT_THRESHOLD_KB: '1024',
    });

    expect(envLimits.IMAGE_MAX_SIZE_BYTES).toBe(7.5 * 1024 * 1024);
    expect(envLimits.VIDEO_MAX_SIZE_BYTES).toBe(90 * 1024 * 1024);
    expect(envLimits.DOCUMENT_MAX_SIZE_BYTES).toBe(300 * 1024 * 1024);
    expect(envLimits.TRANSCRIPT_MAX_SIZE_BYTES).toBe(10 * 1024 * 1024);
    expect(envLimits.MAX_IMAGES_PER_BATCH).toBe(4);
    expect(envLimits.MAX_DOCUMENTS_PER_BATCH).toBe(250);
    expect(envLimits.MAX_VIDEOS_PER_BATCH).toBe(2);
    expect(envLimits.IMAGE_COMPRESSION_THRESHOLD_KB).toBe(512);
    expect(envLimits.MAX_EXTRACTED_TEXT_CHARS).toBe(64000);
    expect(envLimits.LARGE_DOCUMENT_THRESHOLD_BYTES).toBe(1024 * 1024);
  });

  it('ignores invalid env values', async () => {
    const { UPLOAD_LIMITS: envLimits } = await importUploadLimitsWithEnv({
      NEXT_PUBLIC_UPLOAD_DOCUMENT_SERVER_LIMIT_MB: 'not-a-number',
      NEXT_PUBLIC_UPLOAD_MAX_DOCUMENTS_PER_BATCH: '-1',
    });

    expect(envLimits.DOCUMENT_MAX_SIZE_BYTES).toBe(200 * 1024 * 1024);
    expect(envLimits.MAX_DOCUMENTS_PER_BATCH).toBe(20);
  });

  it('caps the public image setting at the fixed image route limit', async () => {
    const { UPLOAD_LIMITS: envLimits } = await importUploadLimitsWithEnv({
      NEXT_PUBLIC_UPLOAD_IMAGE_SERVER_LIMIT_MB: '100',
    });

    expect(envLimits.IMAGE_MAX_SIZE_BYTES).toBe(7.5 * 1024 * 1024);
    expect(envLimits.IMAGE_MAX_SIZE_MB).toBe(7);
  });

  it('caps the public transcript setting at the fixed VTT route limit', async () => {
    const { UPLOAD_LIMITS: envLimits } = await importUploadLimitsWithEnv({
      NEXT_PUBLIC_UPLOAD_TRANSCRIPT_MAX_MB: '50',
    });

    expect(envLimits.TRANSCRIPT_MAX_SIZE_BYTES).toBe(10 * 1024 * 1024);
    expect(envLimits.TRANSCRIPT_MAX_SIZE_MB).toBe(10);
  });
});
