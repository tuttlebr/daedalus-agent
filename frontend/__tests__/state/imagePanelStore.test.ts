import { useImagePanelStore, type HistoryEntry } from '@/state/imagePanelStore';
import { beforeEach, describe, expect, it } from 'vitest';

const output = {
  imageId: 'output-1',
  prompt: 'A concise prompt',
  mode: 'generate' as const,
  model: 'gpt-image-2' as const,
  params: { output_format: 'png' as const },
  createdAt: 1,
};

const entry: HistoryEntry = {
  id: 'history-1',
  mode: 'generate',
  prompt: output.prompt,
  params: output.params,
  inputImages: [],
  maskImage: null,
  outputImageIds: [output.imageId],
  model: output.model,
  createdAt: output.createdAt,
};

describe('image panel history and assets', () => {
  beforeEach(() => {
    useImagePanelStore.getState().clearAll();
    useImagePanelStore.getState().setHistory([]);
  });

  it('keeps the current canvas when history metadata is cleared or a run is removed', () => {
    const store = useImagePanelStore.getState();
    store.setGallery([output]);
    store.setHistory([entry]);

    store.removeFromHistory(entry.id);
    expect(useImagePanelStore.getState().gallery).toEqual([output]);

    store.setHistory([entry]);
    store.clearHistory();
    expect(useImagePanelStore.getState().history).toEqual([]);
    expect(useImagePanelStore.getState().gallery).toEqual([output]);
  });

  it('clears a mask if its primary input image is removed', () => {
    const store = useImagePanelStore.getState();
    store.addInputImages([
      { imageId: 'source-png', sessionId: 'session', mimeType: 'image/png' },
      { imageId: 'source-2', sessionId: 'session', mimeType: 'image/png' },
    ]);
    store.setMaskImage({
      imageId: 'mask',
      sessionId: 'session',
      mimeType: 'image/png',
    });

    store.removeInputImage('source-2');
    expect(useImagePanelStore.getState().maskImage?.imageId).toBe('mask');

    store.removeInputImage('source-png');
    expect(useImagePanelStore.getState().maskImage).toBeNull();
  });
});
