import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useFileSave } from '@/hooks/useFileSave';

import { saveArtifactBlob } from '@/utils/app/sandboxArtifactDownload';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/app/sandboxArtifactDownload', () => ({
  saveArtifactBlob: vi.fn(),
}));

let root: Root;
let host: HTMLDivElement;
let share: ReturnType<typeof vi.fn>;
const bytes = new Uint8Array([0, 255, 137, 80, 78, 71]);
const blob = new Blob([bytes], { type: 'image/png' });

function Harness() {
  const { saveFile, fileSaveDialog } = useFileSave();
  return (
    <>
      <button
        onClick={async () => {
          await Promise.resolve();
          saveFile(blob, 'original.png');
        }}
      >
        Prepare
      </button>
      {fileSaveDialog}
    </>
  );
}
function button(name: string) {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent === name,
  )!;
}

describe('iOS file saving', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
    share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: share,
    });
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: vi.fn(() => true),
    });
    vi.mocked(saveArtifactBlob).mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Reflect.deleteProperty(navigator, 'share');
    Reflect.deleteProperty(navigator, 'canShare');
    Reflect.deleteProperty(navigator, 'maxTouchPoints');
    vi.restoreAllMocks();
  });

  it('requires a fresh tap after async preparation and shares the original file', async () => {
    await act(async () => button('Prepare').click());
    expect(document.querySelector('dialog')?.open).toBe(true);
    expect(share).not.toHaveBeenCalled();
    await act(async () => {
      button('Save').click();
      expect(share).toHaveBeenCalledTimes(1);
    });
    const file = share.mock.calls[0][0].files[0] as File;
    expect(file.name).toBe('original.png');
    expect(file.type).toBe('image/png');
    const reader = new FileReader();
    const data = new Promise<ArrayBuffer>((resolve) => {
      reader.onload = () => resolve(reader.result as ArrayBuffer);
    });
    reader.readAsArrayBuffer(file);
    expect(new Uint8Array(await data)).toEqual(bytes);
    expect(document.querySelector('dialog')).toBeNull();
    expect(saveArtifactBlob).not.toHaveBeenCalled();
  });
  it('dismisses a cancelled share without navigating or downloading', async () => {
    share.mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    await act(async () => button('Prepare').click());
    await act(async () => button('Save').click());
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
    expect(saveArtifactBlob).not.toHaveBeenCalled();
  });
  it('keeps the prepared file available after a failed share', async () => {
    share.mockRejectedValueOnce(new Error('Share failed'));
    await act(async () => button('Prepare').click());
    await act(async () => button('Save').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Try again',
    );
    await act(async () => button('Save').click());
    expect(share).toHaveBeenCalledTimes(2);
    expect(share.mock.calls[0][0].files[0]).toBe(
      share.mock.calls[1][0].files[0],
    );
  });
  it('offers an in-app exit when file sharing is unavailable', async () => {
    Reflect.deleteProperty(navigator, 'share');
    await act(async () => button('Prepare').click());
    expect(button('Save').disabled).toBe(true);
    await act(async () => button('Cancel').click());
    expect(document.querySelector('dialog')).toBeNull();
    expect(saveArtifactBlob).not.toHaveBeenCalled();
  });
  it('uses the save sheet for iPadOS desktop browsing', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 5,
    });
    await act(async () => button('Prepare').click());
    expect(button('Save')).toBeDefined();
    expect(saveArtifactBlob).not.toHaveBeenCalled();
  });
  it('retains direct downloads on other platforms', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Desktop');
    await act(async () => button('Prepare').click());
    expect(saveArtifactBlob).toHaveBeenCalledWith(blob, 'original.png');
    expect(document.querySelector('dialog')).toBeNull();
  });
});
