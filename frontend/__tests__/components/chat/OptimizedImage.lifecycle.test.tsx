import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { OptimizedImage } from '@/components/chat/OptimizedImage';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), revoke: vi.fn() }));
vi.mock('@/utils/app/imageHandler', () => ({
  fetchImageAsBlob: mocks.fetch,
  revokeImageBlob: mocks.revoke,
  getImageUrl: () => '/test-image',
}));

describe('image resource lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private callback: (entries: any[]) => void) {}
        observe() {
          this.callback([{ isIntersecting: true }]);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  const renderImage = (imageId: string, alt = 'image') => (
    <OptimizedImage imageRef={{ imageId, sessionId: 'generated' }} alt={alt} />
  );

  it('releases the URL when an unmounted consumer finishes loading', async () => {
    let resolve!: (url: string) => void;
    mocks.fetch.mockReturnValue(
      new Promise<string>((r) => {
        resolve = r;
      }),
    );
    act(() => root.render(renderImage('pending')));
    act(() => root.render(null));
    await act(async () => {
      resolve('blob:pending');
    });
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(
      'pending-thumb',
      'blob:pending',
    );
  });

  it('clears the old image immediately and loads the new identity', async () => {
    mocks.fetch.mockResolvedValueOnce('blob:first');
    await act(async () => root.render(renderImage('first')));
    expect(container.querySelector('img')?.src).toBe('blob:first');
    let finish!: (url: string) => void;
    mocks.fetch.mockReturnValueOnce(
      new Promise<string>((r) => {
        finish = r;
      }),
    );
    await act(async () => root.render(renderImage('second')));
    expect(container.querySelector('img')).toBeNull();
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(
      'first-thumb',
      'blob:first',
    );
    await act(async () => {
      finish('blob:second');
    });
    expect(container.querySelector('img')?.src).toBe('blob:second');
  });

  it('does not release the displayed blob on presentation-only changes', async () => {
    mocks.fetch.mockResolvedValue('blob:retained');
    await act(async () =>
      root.render(renderImage('retained', 'old description')),
    );
    await act(async () =>
      root.render(renderImage('retained', 'new description')),
    );
    expect(container.querySelector('img')?.alt).toBe('new description');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it('keeps thumbnail ownership while opening and closing full resolution', async () => {
    mocks.fetch.mockImplementation((_ref, thumbnail) =>
      Promise.resolve(thumbnail ? 'blob:thumb' : 'blob:full'),
    );
    await act(async () => root.render(renderImage('image')));
    await act(async () =>
      container.querySelector('img')!.dispatchEvent(new Event('load')),
    );
    await act(async () =>
      (
        container.querySelector(
          '[aria-label="View image fullscreen"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(document.querySelector('dialog img')?.getAttribute('src')).toBe(
      'blob:full',
    );
    expect(mocks.revoke).not.toHaveBeenCalled();
    await act(async () =>
      (
        document.querySelector(
          '[aria-label="Close fullscreen"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith('image', 'blob:full');
    act(() => root.render(null));
    expect(mocks.revoke).toHaveBeenCalledWith('image-thumb', 'blob:thumb');
    expect(mocks.revoke).toHaveBeenCalledTimes(2);
  });

  it('notifies consumers only after decoding and ignores a detached image', async () => {
    mocks.fetch.mockResolvedValue('blob:decode');
    const onLoad = vi.fn();
    await act(async () =>
      root.render(
        <OptimizedImage
          imageRef={{ imageId: 'decode', sessionId: 'generated' }}
          onLoad={onLoad}
        />,
      ),
    );
    const img = container.querySelector('img')!;
    let finish!: () => void;
    img.decode = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    await act(async () => img.dispatchEvent(new Event('load')));
    expect(onLoad).not.toHaveBeenCalled();
    act(() => root.render(null));
    await act(async () => {
      finish();
    });
    expect(onLoad).not.toHaveBeenCalled();
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(
      'decode-thumb',
      'blob:decode',
    );
  });
});
