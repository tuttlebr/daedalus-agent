import {
  clearPrivateCaches,
  registerServiceWorker,
  setOnUpdateAvailable,
} from '@/utils/app/pwa';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/app/visibilityAwareTimer', () => ({
  createVisibilityAwareInterval: vi.fn(),
}));

function serviceWorkerRegistration(controller: object | null) {
  let state = 'installing';
  const worker = new EventTarget();
  Object.defineProperty(worker, 'state', { get: () => state });

  const registration = new EventTarget();
  Object.defineProperty(registration, 'installing', { get: () => worker });
  const register = vi.fn().mockResolvedValue(registration);
  vi.stubGlobal('navigator', {
    serviceWorker: { controller, register },
  });

  return {
    activate() {
      registration.dispatchEvent(new Event('updatefound'));
      state = 'activated';
      worker.dispatchEvent(new Event('statechange'));
    },
    register,
  };
}

describe('registerServiceWorker', () => {
  afterEach(() => {
    setOnUpdateAvailable(vi.fn());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('does not report the first worker activation as an update', async () => {
    const onUpdate = vi.fn();
    const registration = serviceWorkerRegistration(null);
    setOnUpdateAvailable(onUpdate);

    await registerServiceWorker();
    registration.activate();

    expect(registration.register).toHaveBeenCalledWith('/sw.js', {
      scope: '/',
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('reports activation when an older worker already controls the page', async () => {
    const onUpdate = vi.fn();
    const registration = serviceWorkerRegistration({});
    setOnUpdateAvailable(onUpdate);

    await registerServiceWorker();
    registration.activate();

    expect(onUpdate).toHaveBeenCalledOnce();
  });
});

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
