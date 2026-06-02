import { clearPrivateCaches } from '@/utils/app/pwa';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('clearPrivateCaches', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('posts CLEAR_PRIVATE_CACHES to the controlling worker', async () => {
    const postMessage = vi.fn();
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: { postMessage },
        getRegistration: vi.fn(),
      },
    });

    await clearPrivateCaches();

    expect(postMessage).toHaveBeenCalledWith({ type: 'CLEAR_PRIVATE_CACHES' });
  });

  it('falls back to the active registration when there is no controller', async () => {
    const postMessage = vi.fn();
    const getRegistration = vi
      .fn()
      .mockResolvedValue({ active: { postMessage } });
    vi.stubGlobal('navigator', {
      serviceWorker: { controller: null, getRegistration },
    });

    await clearPrivateCaches();

    expect(getRegistration).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: 'CLEAR_PRIVATE_CACHES' });
  });

  it('does not throw when the service worker API is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    await expect(clearPrivateCaches()).resolves.toBeUndefined();
  });

  it('deletes the private caches directly from the page (works without a controlling SW)', async () => {
    const cachesDelete = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { delete: cachesDelete });
    vi.stubGlobal('navigator', {}); // no service worker controlling the page

    await clearPrivateCaches();

    expect(cachesDelete).toHaveBeenCalledWith('daedalus-conversations-v1');
    expect(cachesDelete).toHaveBeenCalledWith('daedalus-runtime');
  });
});
