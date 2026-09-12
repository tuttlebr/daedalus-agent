import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ImageDownloadAction } from '@/components/images/ImageDownloadAction';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const imageId = 'abc-123';
const originalBytes = new Uint8Array([0, 255, 137, 80, 78, 71, 13, 10]);
let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let share: ReturnType<typeof vi.fn>;

function response(format = 'png') {
  return {
    ok: true,
    headers: new Headers({
      'Content-Disposition': `attachment; filename="daedalus-${imageId}.${format}"`,
    }),
    blob: async () =>
      new Blob([originalBytes], {
        type: `image/${format === 'jpg' ? 'jpeg' : format}`,
      }),
  };
}

function render(id = imageId) {
  root.render(
    <ImageDownloadAction imageId={id} icon={<span />} className="action" />,
  );
}

function click() {
  container.querySelector('button')!.click();
}

describe('ImageDownloadAction', () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
    share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: share,
    });
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    });
    fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (navigator as Partial<Navigator>).share;
    delete (navigator as Partial<Navigator>).canShare;
    Reflect.deleteProperty(navigator, 'maxTouchPoints');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['png', 'jpg', 'webp'])(
    'shares original %s bytes on the tap without navigating',
    async (format) => {
      fetchMock.mockResolvedValue(response(format));
      await act(async () => render());
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/generated-image/${imageId}?download=1`,
        expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
      );
      expect(share).not.toHaveBeenCalled();
      expect(container.querySelector('a')).toBeNull();
      await act(async () => {
        click();
        // No network await between the user gesture and navigator.share.
        expect(share).toHaveBeenCalledTimes(1);
      });
      const data = share.mock.calls[0][0] as ShareData;
      expect(Object.keys(data)).toEqual(['files']);
      const file = data.files![0];
      expect(file.name).toBe(`daedalus-${imageId}.${format}`);
      expect(file.type).toBe(
        format === 'jpg' ? 'image/jpeg' : `image/${format}`,
      );
      const reader = new FileReader();
      const bytes = new Promise<ArrayBuffer>((resolve) => {
        reader.onload = () => resolve(reader.result as ArrayBuffer);
      });
      reader.readAsArrayBuffer(file);
      expect(new Uint8Array(await bytes)).toEqual(originalBytes);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(container.querySelector('button')?.disabled).toBe(false);
    },
  );

  it('uses the save sheet for iPads reporting a Mac platform', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 5,
    });
    await act(async () => render());
    await act(async () => click());
    expect(share).toHaveBeenCalledTimes(1);
    expect(container.querySelector('a')).toBeNull();
  });

  it('leaves cancellation in Create and allows another save attempt', async () => {
    share.mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError'));
    await act(async () => render());
    await act(async () => click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    await act(async () => click());
    expect(share).toHaveBeenCalledTimes(2);
  });

  it('keeps share failures in the app without following a download link', async () => {
    share.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    await act(async () => render());
    await act(async () => click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not open',
    );
    expect(container.querySelector('a')).toBeNull();
    await act(async () => click());
    expect(share).toHaveBeenCalledTimes(2);
  });

  it('allows a failed image fetch to be retried', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    await act(async () => render());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not prepare',
    );
    await act(async () => click());
    expect(share).not.toHaveBeenCalled();
    await act(async () => click());
    expect(share).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['missing API', 'unsupported file'])(
    'does not navigate on iOS with %s',
    async (reason) => {
      if (reason === 'missing API')
        delete (navigator as Partial<Navigator>).share;
      else vi.mocked(navigator.canShare).mockReturnValue(false);
      await act(async () => render());
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Saving is unavailable',
      );
      expect(container.querySelector('button')?.disabled).toBe(true);
      expect(container.querySelector('a')).toBeNull();
    },
  );

  it('discards the previous file while preparing a new selection', async () => {
    await act(async () => render());
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => render('def-456'));
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(container.querySelector('button')?.disabled).toBe(true);
    await act(async () => click());
    expect(share).not.toHaveBeenCalled();
    act(() => root.render(null));
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
  });

  it.each(['Android', 'Macintosh', 'Windows'])(
    'uses a direct download on %s without prefetching',
    async (userAgent) => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
      await act(async () => render());
      const link = container.querySelector('a')!;
      expect(link.getAttribute('href')).toBe(
        `/api/generated-image/${imageId}?download=1`,
      );
      expect(link.hasAttribute('download')).toBe(true);
      expect(link.hasAttribute('target')).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
