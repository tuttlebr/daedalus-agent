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
    createObjectURL.mockClear();
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

  it('keeps a released image cached and reuses it on the next request', async () => {
    mockImageFetch(128);
    const { fetchImageAsBlob, revokeImageBlob } = await import(
      '@/utils/app/imageHandler'
    );

    const ref = { imageId: 'single', sessionId: 'generated' };
    const url = await fetchImageAsBlob(ref, true);
    revokeImageBlob('single-thumb', url);
    vi.advanceTimersByTime(100);

    // The last consumer left; the blob stays within the cache budget so a
    // remount does not refetch it.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(await fetchImageAsBlob(ref, true)).toBe(url);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('revokes released images once they go stale', async () => {
    mockImageFetch(128);
    const { fetchImageAsBlob, revokeImageBlob } = await import(
      '@/utils/app/imageHandler'
    );

    const url = await fetchImageAsBlob(
      { imageId: 'stale', sessionId: 'generated' },
      true,
    );
    revokeImageBlob('stale-thumb', url);
    // The sweep timer is registered after a dynamic import; run its callback
    // directly once the desktop staleness window (five minutes) has passed.
    await vi.advanceTimersByTimeAsync(0);
    const { createVisibilityAwareInterval } = await import(
      '@/utils/app/visibilityAwareTimer'
    );
    // Earlier tests' cache instances also registered sweeps; take this
    // instance's (the latest one-minute interval).
    const sweep = [...vi.mocked(createVisibilityAwareInterval).mock.calls]
      .reverse()
      .find(([, options]) => options.interval === 60000)![0];
    vi.setSystemTime(Date.now() + 4 * 60 * 1000);
    sweep();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    sweep();

    expect(revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it('retains a shared concurrent image until both consumers release it', async () => {
    mockImageFetch(128);
    const { fetchImageAsBlob, revokeImageBlob } = await import(
      '@/utils/app/imageHandler'
    );
    const ref = { imageId: 'shared', sessionId: 'generated' };
    const [first, second] = await Promise.all([
      fetchImageAsBlob(ref, true),
      fetchImageAsBlob(ref, true),
    ]);
    expect(first).toBe(second);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    revokeImageBlob('shared-thumb', first);
    revokeImageBlob('shared-thumb', second);
    vi.advanceTimersByTime(100);
    // Both consumers released it; the entry waits in the cache for reuse and
    // is revoked only by eviction, staleness, memory pressure or clearAll.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    const { clearPrivateCaches } = await import('@/utils/app/pwa');
    await clearPrivateCaches();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(first);
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

  it('releases a temporary URL without dropping a later cached copy', async () => {
    mockImageFetch(2 * 1024 * 1024);
    const { fetchImageAsBlob, revokeImageBlob } = await import(
      '@/utils/app/imageHandler'
    );
    const other = { imageId: 'other', sessionId: 'generated' };
    const shared = { imageId: 'shared', sessionId: 'generated' };

    const otherUrl = await fetchImageAsBlob(other);
    // The cache is full of a referenced image, so this consumer gets a
    // temporary URL that the cache does not own.
    const temporaryUrl = await fetchImageAsBlob(shared);
    revokeImageBlob('other', otherUrl);
    vi.advanceTimersByTime(100);
    // Another consumer now loads the same image into the freed cache.
    const cachedUrl = await fetchImageAsBlob(shared);
    expect(cachedUrl).not.toBe(temporaryUrl);

    revokeImageBlob('shared', temporaryUrl);
    vi.advanceTimersByTime(100);
    expect(revokeObjectURL).toHaveBeenCalledWith(temporaryUrl);
    expect(revokeObjectURL).not.toHaveBeenCalledWith(cachedUrl);
  });

  it('invalidates pending image loads when private caches are cleared', async () => {
    mockImageFetch(128);
    let resolveOld!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise((resolve) => (resolveOld = resolve)),
    );
    const { fetchImageAsBlob } = await import('@/utils/app/imageHandler');
    const { clearPrivateCaches } = await import('@/utils/app/pwa');
    const ref = { imageId: 'pending', sessionId: 'generated' };
    const oldLoad = fetchImageAsBlob(ref).then(
      (url) => ({ url, error: undefined }),
      (error: Error) => ({ url: undefined, error }),
    );

    await clearPrivateCaches();
    const newLoad = fetchImageAsBlob(ref);
    resolveOld({
      ok: true,
      blob: async () => new Blob(['old private image']),
    } as Response);

    const oldResult = await oldLoad;
    expect(oldResult.error?.name).toBe('AbortError');
    expect(oldResult.url).toBeUndefined();
    await expect(newLoad).resolves.toBe('blob:test-1');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('does not release a new image reference when an old consumer unmounts', async () => {
    mockImageFetch(128);
    const { fetchImageAsBlob, revokeImageBlob } = await import(
      '@/utils/app/imageHandler'
    );
    const { clearPrivateCaches } = await import('@/utils/app/pwa');
    const ref = { imageId: 'reused', sessionId: 'generated' };
    const oldUrl = await fetchImageAsBlob(ref);
    await clearPrivateCaches();
    expect(revokeObjectURL).toHaveBeenCalledWith(oldUrl);
    const newUrl = await fetchImageAsBlob(ref);
    expect(newUrl).not.toBe(oldUrl);

    revokeImageBlob('reused', oldUrl);
    vi.advanceTimersByTime(100);
    expect(revokeObjectURL).not.toHaveBeenCalledWith(newUrl);
    // The new consumer's release returns the entry to the cache; it is still
    // served on the next request.
    revokeImageBlob('reused', newUrl);
    vi.advanceTimersByTime(100);
    expect(revokeObjectURL).not.toHaveBeenCalledWith(newUrl);
    expect(await fetchImageAsBlob(ref)).toBe(newUrl);
  });
});
