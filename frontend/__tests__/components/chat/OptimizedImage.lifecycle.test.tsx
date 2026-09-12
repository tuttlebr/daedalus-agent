import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { OptimizedImage } from '@/components/chat/OptimizedImage';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), revoke: vi.fn() }));
vi.mock('@/utils/app/imageHandler', () => ({
  fetchImageAsBlob: mocks.fetch,
  revokeImageBlob: mocks.revoke,
  getImageUrl: () => '/test-image',
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
describe('image load cancellation', () => {
  it('releases the URL when an unmounted consumer finishes loading', async () => {
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
    let resolve!: (url: string) => void;
    mocks.fetch.mockReturnValue(
      new Promise<string>((r) => {
        resolve = r;
      }),
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    act(() => {
      root.render(
        <OptimizedImage
          imageRef={{ imageId: 'pending', sessionId: 'generated' }}
        />,
      );
    });
    act(() => root.unmount());
    await act(async () => {
      resolve('blob:pending');
    });
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(
      'pending-thumb',
      'blob:pending',
    );
  });
});
