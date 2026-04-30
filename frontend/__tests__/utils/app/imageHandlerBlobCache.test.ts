import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/app/visibilityAwareTimer', () => ({
  createVisibilityAwareInterval: vi.fn(() => ({ stop: vi.fn() })),
}));

const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();

function mockImageFetch(size: number) {
  global.fetch = vi.fn(async () => {
    const blob = new Blob([new Uint8Array(size)], { type: 'image/png' });
    return {
      ok: true,
      statusText: 'OK',
      blob: vi.fn().mockResolvedValue(blob),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('imageHandler blob cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    let nextUrl = 0;
    createObjectURL.mockImplementation(() => `blob:test-${++nextUrl}`);
    revokeObjectURL.mockClear();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });
  });

  afterEach(async () => {
    const { clearAllImageBlobs } = await import('@/utils/app/imageHandler');
    clearAllImageBlobs();
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('does not hang when the cache is full of referenced images', async () => {
    mockImageFetch(2 * 1024 * 1024);
    const { fetchImageAsBlob } = await import('@/utils/app/imageHandler');

    const firstUrl = await fetchImageAsBlob(
      { imageId: 'first', sessionId: 'generated' },
      true,
    );
    const secondUrl = await fetchImageAsBlob(
      { imageId: 'second', sessionId: 'generated' },
      true,
    );

    expect(firstUrl).toBe('blob:test-1');
    expect(secondUrl).toBe('blob:test-2');
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('releases a single cached reference on cleanup', async () => {
    mockImageFetch(128);
    const { fetchImageAsBlob, revokeImageBlob } = await import(
      '@/utils/app/imageHandler'
    );

    const url = await fetchImageAsBlob(
      { imageId: 'single', sessionId: 'generated' },
      true,
    );
    revokeImageBlob('single-thumb', url);
    vi.advanceTimersByTime(100);

    expect(revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it('revokes oversized temporary blob URLs directly', async () => {
    mockImageFetch(4 * 1024 * 1024);
    const { fetchImageAsBlob, revokeImageBlob } = await import(
      '@/utils/app/imageHandler'
    );

    const url = await fetchImageAsBlob(
      { imageId: 'oversized', sessionId: 'generated' },
      false,
    );
    revokeImageBlob('oversized', url);

    expect(revokeObjectURL).toHaveBeenCalledWith(url);
  });
});
