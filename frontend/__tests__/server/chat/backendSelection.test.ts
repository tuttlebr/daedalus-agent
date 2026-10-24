// @vitest-environment node
import {
  resetStreamBackendPin,
  selectStreamBackendBaseUrl,
} from '@/server/chat/backendSelection';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve4: vi.fn() }));
vi.mock('node:dns/promises', () => ({ resolve4: mocks.resolve4 }));

describe('bounded backend health selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '10.0.0.1');
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    resetStreamBackendPin();
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('selects a healthy pod without waiting for earlier unresponsive pods', async () => {
    mocks.resolve4.mockResolvedValue(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, options: RequestInit) => {
        const signal = options.signal!;
        signals.push(signal);
        expect(options.method).toBe('GET');
        expect(options.headers).toMatchObject({ 'x-user-id': 'alice' });
        return new Promise<Response>((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
          if (url.includes('10.0.0.3:'))
            setTimeout(() => resolve(new Response(null)), 20);
        });
      }),
    );
    let selected: string | undefined;
    const selecting = selectStreamBackendBaseUrl(
      'job-1',
      'alice',
      'session',
    ).then((url) => {
      selected = url;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(selected).toBe('http://10.0.0.3:8000');
    await selecting;
    expect(signals.slice(0, 2).every((signal) => signal.aborted)).toBe(true);
  });

  it('bounds probes and advances through failed candidates', async () => {
    mocks.resolve4.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => `10.0.0.${i + 1}`),
    );
    let active = 0;
    let maximum = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url: string, options: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            active += 1;
            maximum = Math.max(maximum, active);
            const timer = setTimeout(() => {
              active -= 1;
              resolve(
                new Response(null, {
                  status: url.includes('10.0.0.7:') ? 200 : 503,
                }),
              );
            }, 20);
            options.signal!.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                active -= 1;
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          }),
      ),
    );
    const selecting = selectStreamBackendBaseUrl('job-1', 'alice', 'session');
    await vi.runAllTimersAsync();
    expect(await selecting).toBe('http://10.0.0.7:8000');
    expect(maximum).toBe(3);
  });

  it('retains bounded retries and a public error when every pod fails', async () => {
    mocks.resolve4.mockResolvedValue(['10.0.0.1', '10.0.0.2']);
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const rejected = expect(
      selectStreamBackendBaseUrl('job-1', 'alice', 'session'),
    ).rejects.toMatchObject({
      status: 502,
      message:
        'The assistant backend is temporarily unavailable. Please try again shortly.',
    });
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
