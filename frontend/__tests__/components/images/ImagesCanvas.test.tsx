import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ImagesCanvas } from '@/components/images/ImagesCanvas';

import type { GalleryImage } from '@/state/imagePanelStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), revoke: vi.fn() }));
vi.mock('@/utils/app/imageHandler', () => ({
  fetchImageAsBlob: mocks.fetch,
  revokeImageBlob: mocks.revoke,
  getImageUrl: () => '/image',
}));
vi.mock('@/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
  useMediaQuery: () => true,
}));

const output = (imageId: string, partial = false): GalleryImage => ({
  imageId,
  partial,
  prompt: imageId,
  mode: 'generate',
  model: 'gpt-image-2.5-sunburst',
  params: {},
  createdAt: 1,
});

describe('progressive output rendering', () => {
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
        disconnect() {}
      },
    );
    mocks.fetch.mockImplementation((ref) =>
      Promise.resolve(`blob:${ref.imageId}`),
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
  const render = async (image: GalleryImage) => {
    await act(async () =>
      root.render(
        <ImagesCanvas
          images={[image]}
          loading={!!image.partial}
          expectedCount={1}
          generationStatus={image.partial ? 'generating' : 'idle'}
          elapsedMs={1000}
          selectedImageId={null}
          onSelectImage={() => {}}
        />,
      ),
    );
  };
  const load = async (id: string) => {
    await act(async () =>
      container
        .querySelector(`img[alt="${id}"]`)!
        .dispatchEvent(new Event('load')),
    );
  };

  it('keeps the decoded preview until the final is decoded, then enables its actions', async () => {
    await render(output('preview', true));
    await load('preview');
    expect(container.querySelector('button')!.disabled).toBe(true);
    await render(output('final'));
    const old = container.querySelector(
      'img[alt="preview"]',
    ) as HTMLImageElement;
    expect(old.style.visibility).toBe('visible');
    expect(container.textContent).toContain('Loading final image');
    const final = container.querySelector(
      'img[alt="final"]',
    ) as HTMLImageElement;
    let finish!: () => void;
    final.decode = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    await load('final');
    expect(old.isConnected).toBe(true);
    expect(container.querySelector('button')!.disabled).toBe(true);
    await act(async () => {
      finish();
    });
    expect(old.isConnected).toBe(false);
    expect(final.style.visibility).toBe('visible');
    expect(container.querySelector('button')!.disabled).toBe(false);
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(
      'preview-thumb',
      'blob:preview',
    );
  });

  it('does not replace a visible preview with an obsolete pending revision', async () => {
    await render(output('first', true));
    await load('first');
    let finish!: (url: string) => void;
    mocks.fetch.mockImplementationOnce(
      () =>
        new Promise<string>((r) => {
          finish = r;
        }),
    );
    await render(output('second', true));
    await render(output('final'));
    await act(async () => {
      finish('blob:second');
    });
    expect(container.querySelector('img[alt="second"]')).toBeNull();
    expect(container.querySelector('img[alt="first"]')).not.toBeNull();
    expect(mocks.revoke).toHaveBeenCalledWith('second-thumb', 'blob:second');
    await load('final');
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img')?.alt).toBe('final');
  });
});
