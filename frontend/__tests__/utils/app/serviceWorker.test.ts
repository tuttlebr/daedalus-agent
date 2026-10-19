// @vitest-environment node
import { branding } from '@/generated/branding';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const origin = 'https://daedalus.test';
const source = readFileSync(resolve('public/sw.js'), 'utf8');
const precacheName = `daedalus-v3-${branding.version}`;
const runtimeName = 'daedalus-runtime';
type CacheKey = string | Request;
const key = (input: CacheKey) =>
  new URL(typeof input === 'string' ? input : input.url, origin).href;

class MemoryCache {
  entries = new Map<string, Response>();
  async match(request: CacheKey) {
    return this.entries.get(key(request))?.clone();
  }
  async put(request: CacheKey, response: Response) {
    this.entries.set(key(request), response.clone());
  }
  async delete(request: CacheKey) {
    return this.entries.delete(key(request));
  }
}

// IndexedDB is a persistence boundary. Keep its request callbacks asynchronous
// and share the stored records across separate worker VM lifetimes.
function metadataStore() {
  const records = new Map<string, Record<string, any>>();
  function request<T>(operation: () => T) {
    const result: { result?: T; onsuccess?: () => void } = {};
    queueMicrotask(() => {
      result.result = operation();
      result.onsuccess?.();
    });
    return result;
  }
  const store = {
    getAll: () =>
      request(() => [...records.values()].map((value) => ({ ...value }))),
    put: (value: Record<string, any>) =>
      request(() => records.set(value.url, { ...value })),
    delete: (url: string) => request(() => records.delete(url)),
    clear: () => request(() => records.clear()),
  };
  const indexedDB = {
    open: () =>
      request(() => ({ transaction: () => ({ objectStore: () => store }) })),
  };
  return { indexedDB, records };
}

function worker(
  options: {
    buckets?: Map<string, MemoryCache>;
    indexedDB?: ReturnType<typeof metadataStore>['indexedDB'];
    usageRatio?: number;
  } = {},
) {
  const buckets = options.buckets ?? new Map<string, MemoryCache>();
  const cache = (name: string) => {
    if (!buckets.has(name)) buckets.set(name, new MemoryCache());
    return buckets.get(name)!;
  };
  const handlers = new Map<string, ((event: any) => void)[]>();
  const timers = new Map<number, () => void>();
  const fetch = vi.fn(
    async (_request: Request, _init?: RequestInit) => new Response('NEW'),
  );
  const caches = {
    open: async (name: string) => cache(name),
    keys: async () => [...buckets.keys()],
    delete: async (name: string) => buckets.delete(name),
    match: async (request: CacheKey) => {
      for (const bucket of buckets.values()) {
        const response = await bucket.match(request);
        if (response) return response;
      }
    },
  };
  runInNewContext(source, {
    URL,
    Request,
    Response,
    caches,
    fetch,
    indexedDB: options.indexedDB,
    navigator: {
      storage: {
        estimate: async () => ({
          usage: (options.usageRatio ?? 0) * 100,
          quota: 100,
        }),
      },
    },
    console: { log() {}, warn() {}, error() {} },
    setInterval(callback: () => void, interval: number) {
      timers.set(interval, callback);
    },
    self: {
      ...(options.indexedDB ? { indexedDB: options.indexedDB } : {}),
      location: { origin },
      clients: { claim() {} },
      addEventListener: (type: string, handler: (event: any) => void) => {
        handlers.set(type, [...(handlers.get(type) || []), handler]);
      },
    },
  });
  async function dispatch(type: string, data: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    const event = {
      ...data,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      respondWith: (promise: Promise<Response>) => {
        response = promise;
      },
    };
    handlers.get(type)?.forEach((handler) => handler(event));
    const result = await response;
    await Promise.all(pending);
    return result;
  }
  const request = (url: string, init?: RequestInit) =>
    dispatch('fetch', { request: new Request(key(url), init) });
  return { cache, caches, fetch, dispatch, request, buckets, timers };
}

describe('service worker cache upgrades', () => {
  it('keeps the image limit when responses finish concurrently', async () => {
    const storage = metadataStore();
    const sw = worker(storage);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        sw.request(`/image-${index}.png`),
      ),
    );
    expect(sw.cache(runtimeName).entries.size).toBe(10);
    expect(storage.records.size).toBe(10);
  });
  it('keeps other cached images when refreshing an entry at capacity', async () => {
    const sw = worker();
    for (let index = 0; index < 10; index++)
      await sw.request(`/image-${index}.png`);
    await sw.request('/image-9.png');
    expect(sw.cache(runtimeName).entries.size).toBe(10);
    expect(await sw.cache(runtimeName).match('/image-0.png')).toBeDefined();
  });
  it('restores runtime image accounting after the worker restarts without install', async () => {
    const storage = metadataStore();
    const first = worker(storage);
    for (let index = 0; index < 10; index++)
      await first.request(`/image-${index}.png`);
    expect(storage.records.size).toBe(10);
    const second = worker({ ...storage, buckets: first.buckets });
    await second.request('/image-10.png');
    expect(second.cache(runtimeName).entries.size).toBe(10);
    expect(storage.records.size).toBe(10);
    expect(
      await second.cache(runtimeName).match('/image-10.png'),
    ).toBeDefined();
  });

  it.each([0.69, 0.75])(
    'cleans runtime images only above 70%% storage usage (%s)',
    async (usageRatio) => {
      const sw = worker({ usageRatio });
      for (let index = 0; index < 10; index++)
        await sw.request(`/image-${index}.png`);
      await sw
        .cache(precacheName)
        .put(branding.assets['/favicon.png'], new Response('BRAND'));
      await sw.timers.get(5 * 60_000)!();
      await vi.waitFor(() =>
        expect(sw.cache(runtimeName).entries.size).toBe(
          usageRatio > 0.7 ? 2 : 10,
        ),
      );
      expect(
        await sw.cache(precacheName).match(branding.assets['/favicon.png']),
      ).toBeDefined();
    },
  );

  it('expires persisted runtime entries on activation after a worker restart', async () => {
    const storage = metadataStore();
    const first = worker(storage);
    await first.request('/old.png');
    await first.request('/recent.png');
    storage.records.get(key('/old.png'))!.timestamp =
      Date.now() - 2 * 24 * 60 * 60_000;
    const second = worker({ ...storage, buckets: first.buckets });
    await second.dispatch('activate');
    expect(await second.cache(runtimeName).match('/old.png')).toBeUndefined();
    expect(await second.cache(runtimeName).match('/recent.png')).toBeDefined();
    expect(storage.records.size).toBe(1);
  });

  it('refreshes the precache entry it reads instead of shadowing a runtime copy', async () => {
    const sw = worker();
    const url = branding.assets['/icons/icon-192x192.png'];
    await sw.cache(precacheName).put(url, new Response('OLD'));
    expect(await (await sw.request(url))?.text()).toBe('OLD');
    expect(await (await sw.cache(precacheName).match(url))?.text()).toBe('NEW');
    expect(await (await sw.request(url))?.text()).toBe('NEW');
    expect(await sw.cache(runtimeName).match(url)).toBeUndefined();
    expect(sw.fetch.mock.calls[0][1]).toEqual({ cache: 'no-cache' });
  });

  it.each(['/icons/icon-192x192.png', '/favicon.png', '/manifest.json?v=2'])(
    'revalidates legacy %s and retains the refreshed response offline',
    async (url) => {
      const sw = worker();
      await sw.cache('daedalus-v2').put(url, new Response('OLD_INSTALL'));
      await sw.cache(runtimeName).put(url, new Response('OLD_RUNTIME'));
      expect(await (await sw.request(url))?.text()).toBe('NEW');
      expect(sw.fetch.mock.calls[0][1]).toEqual({ cache: 'no-cache' });
      sw.fetch.mockRejectedValue(new Error('offline'));
      expect(await (await sw.request(url))?.text()).toBe('NEW');
    },
  );

  it('does not fall back to an earlier branding cache and removes it on activation', async () => {
    const sw = worker();
    const url = branding.assets['/favicon.png'];
    await sw.cache('daedalus-v2').put(url, new Response('OLD'));
    expect(await (await sw.request(url))?.text()).toBe('NEW');
    await sw.dispatch('activate');
    expect(await sw.caches.keys()).not.toContain('daedalus-v2');
    sw.fetch.mockRejectedValue(new Error('offline'));
    expect(await (await sw.request(url))?.text()).toBe('NEW');
  });

  it('keeps authenticated API and Voice Studio GETs outside service-worker caches', async () => {
    const sw = worker();
    expect(await sw.request('/api/conversations')).toBeUndefined();
    expect(await sw.request('/voice-studio/private')).toBeUndefined();
    expect(sw.fetch).not.toHaveBeenCalled();
    expect(await sw.caches.keys()).toEqual([]);
  });

  it('still deletes private runtime data on identity changes', async () => {
    const sw = worker();
    await sw.cache(runtimeName).put('/chat', new Response('PRIVATE'));
    await sw
      .cache('daedalus-conversations-v1')
      .put('/api/conversations', new Response('PRIVATE'));
    await sw
      .cache(precacheName)
      .put(branding.assets['/favicon.png'], new Response('BRAND'));
    await sw.dispatch('message', { data: { type: 'CLEAR_PRIVATE_CACHES' } });
    expect(await sw.caches.keys()).toEqual([precacheName]);
  });
});
