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

function worker() {
  const buckets = new Map<string, MemoryCache>();
  const cache = (name: string) => {
    if (!buckets.has(name)) buckets.set(name, new MemoryCache());
    return buckets.get(name)!;
  };
  const handlers = new Map<string, ((event: any) => void)[]>();
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
    console: { log() {}, warn() {}, error() {} },
    setInterval() {},
    self: {
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
  return { cache, caches, fetch, dispatch, request };
}

describe('service worker cache upgrades', () => {
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
