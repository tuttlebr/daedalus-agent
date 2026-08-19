import { describe, expect, it, vi } from 'vitest';

function fileLike(name: string, type: string, size = 0): File {
  return { name, type, size } as File;
}

const UPLOAD_ENV_KEYS = [
  'NEXT_PUBLIC_UPLOAD_BASE64_OVERHEAD_FACTOR',
  'NEXT_PUBLIC_UPLOAD_IMAGE_SERVER_LIMIT_MB',
  'NEXT_PUBLIC_UPLOAD_VIDEO_SERVER_LIMIT_MB',
  'NEXT_PUBLIC_UPLOAD_DOCUMENT_SERVER_LIMIT_MB',
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

describe('UPLOAD_LIMITS env overrides', () => {
  it('accepts the actual 30 MiB image boundary without a base64 haircut', async () => {
    const { UPLOAD_LIMITS: envLimits, validateFileSize: validateWithDefaults } =
      await importUploadLimitsWithEnv({});
    const exactLimit = fileLike('source.png', 'image/png', 30 * 1024 * 1024);
    const overLimit = fileLike('source.png', 'image/png', 30 * 1024 * 1024 + 1);

    expect(envLimits.IMAGE_MAX_SIZE_BYTES).toBe(30 * 1024 * 1024);
    expect(validateWithDefaults(exactLimit, 'image')).toEqual({ valid: true });
    expect(validateWithDefaults(overLimit, 'image')).toMatchObject({
      valid: false,
    });
  });

  it('uses public size and batch settings from env', async () => {
    const { UPLOAD_LIMITS: envLimits } = await importUploadLimitsWithEnv({
      NEXT_PUBLIC_UPLOAD_IMAGE_SERVER_LIMIT_MB: '40',
      NEXT_PUBLIC_UPLOAD_VIDEO_SERVER_LIMIT_MB: '120',
      NEXT_PUBLIC_UPLOAD_DOCUMENT_SERVER_LIMIT_MB: '300',
      NEXT_PUBLIC_UPLOAD_MAX_IMAGES_PER_BATCH: '4',
      NEXT_PUBLIC_UPLOAD_MAX_DOCUMENTS_PER_BATCH: '250',
      NEXT_PUBLIC_UPLOAD_MAX_VIDEOS_PER_BATCH: '2',
      NEXT_PUBLIC_UPLOAD_IMAGE_COMPRESSION_THRESHOLD_KB: '512',
      NEXT_PUBLIC_UPLOAD_MAX_EXTRACTED_TEXT_CHARS: '64000',
      NEXT_PUBLIC_UPLOAD_LARGE_DOCUMENT_THRESHOLD_KB: '1024',
    });

    expect(envLimits.IMAGE_MAX_SIZE_BYTES).toBe(30 * 1024 * 1024);
    expect(envLimits.VIDEO_MAX_SIZE_BYTES).toBe(90 * 1024 * 1024);
    expect(envLimits.DOCUMENT_MAX_SIZE_BYTES).toBe(300 * 1024 * 1024);
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

  it('does not apply base64 overhead to the configured raw image size', async () => {
    const { UPLOAD_LIMITS: envLimits } = await importUploadLimitsWithEnv({
      NEXT_PUBLIC_UPLOAD_IMAGE_SERVER_LIMIT_MB: '20',
      NEXT_PUBLIC_UPLOAD_BASE64_OVERHEAD_FACTOR: '0.5',
    });

    expect(envLimits.IMAGE_MAX_SIZE_BYTES).toBe(20 * 1024 * 1024);
    expect(envLimits.IMAGE_MAX_SIZE_MB).toBe(20);
  });

  it('caps the public image setting at the fixed 30 MiB route limit', async () => {
    const { UPLOAD_LIMITS: envLimits } = await importUploadLimitsWithEnv({
      NEXT_PUBLIC_UPLOAD_IMAGE_SERVER_LIMIT_MB: '100',
    });

    expect(envLimits.IMAGE_MAX_SIZE_BYTES).toBe(30 * 1024 * 1024);
    expect(envLimits.IMAGE_MAX_SIZE_MB).toBe(30);
  });
});
