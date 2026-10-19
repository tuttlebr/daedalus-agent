import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { Image } from '@/components/markdown/Image';
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  fetch: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock('@/utils/app/imageHandler', () => ({
  uploadImage: mocks.upload,
  fetchImageAsBlob: mocks.fetch,
  revokeImageBlob: mocks.revoke,
  getImageUrl: () => '/test-image',
}));
vi.mock('@/hooks/useFileSave', () => ({
  useFileSave: () => ({ saveFile: vi.fn(), fileSaveDialog: null }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const source = (suffix: string) =>
  `data:image/png;base64,${'A'.repeat(128)}${suffix}`;
const reference = (imageId: string) => ({ imageId, sessionId: 'test' });

describe('markdown image lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private callback: (entries: any[]) => void) {}
        observe() {
          this.callback([{ isIntersecting: true }]);
        }
        disconnect() {}
        unobserve() {}
      },
    );
    mocks.fetch.mockImplementation(async (ref) => `blob:${ref.imageId}`);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('falls back after a failed upload in streaming markdown without retrying', async () => {
    const pending = deferred<ReturnType<typeof reference>>();
    mocks.upload
      .mockResolvedValue(reference('unexpected-retry'))
      .mockReturnValueOnce(pending.promise);
    const src = source('FAIL');
    act(() =>
      root.render(
        <MarkdownRenderer allowHtml={false} content={`![inline](${src})`} />,
      ),
    );
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new Error('HTTP 413')));
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(src);
  });

  it.each([false, true])(
    'resolves both images when their bytes are identical=%s',
    async (identical) => {
      const first = deferred<ReturnType<typeof reference>>();
      const second = deferred<ReturnType<typeof reference>>();
      mocks.upload
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const one = source(`SHARED${identical}A`);
      const two = identical ? one : source('SHAREDB');
      act(() =>
        root.render(
          <>
            <Image src={one} alt="one" />
            <Image src={two} alt="two" />
          </>,
        ),
      );
      const count = mocks.upload.mock.calls.length;
      await act(async () => {
        first.resolve(reference('first'));
        second.resolve(reference('second'));
      });
      expect(count).toBe(identical ? 1 : 2);
      expect(
        Array.from(container.querySelectorAll('img')).map((img) => img.src),
      ).toEqual(
        identical
          ? ['blob:first', 'blob:first']
          : ['blob:first', 'blob:second'],
      );
    },
  );

  it('replaces an uploaded image when its source changes', async () => {
    mocks.upload
      .mockResolvedValueOnce(reference('first'))
      .mockResolvedValueOnce(reference('second'));
    await act(async () =>
      root.render(<Image src={source('FIRST')} alt="picture" />),
    );
    expect(container.querySelector('img')?.src).toBe('blob:first');
    await act(async () =>
      root.render(<Image src={source('SECOND')} alt="picture" />),
    );
    expect(container.querySelector('img')?.src).toBe('blob:second');
    expect(mocks.upload).toHaveBeenCalledTimes(2);
  });

  it('does not replace a new external source when an old upload completes', async () => {
    const pending = deferred<ReturnType<typeof reference>>();
    mocks.upload.mockReturnValueOnce(pending.promise);
    act(() => root.render(<Image src={source('STALE')} />));
    act(() => root.render(<Image src="https://example.test/new.png" />));
    await act(async () => pending.resolve(reference('stale')));
    expect(container.querySelector('img')?.src).toBe(
      'https://example.test/new.png',
    );
  });

  it('recovers from a failed external image and updates its description', () => {
    act(() =>
      root.render(<Image src="https://example.test/broken.png" alt="old" />),
    );
    act(() =>
      container.querySelector('img')!.dispatchEvent(new Event('error')),
    );
    act(() =>
      root.render(<Image src="https://example.test/new.png" alt="new" />),
    );
    expect(container.querySelector('img')?.src).toBe(
      'https://example.test/new.png',
    );
    act(() =>
      root.render(<Image src="https://example.test/new.png" alt="updated" />),
    );
    expect(container.querySelector('img')?.alt).toBe('updated');
  });
});
