import { useImagePanelStore, type HistoryEntry } from '@/state/imagePanelStore';
import { beforeEach, describe, expect, it } from 'vitest';

const output = {
  imageId: 'output-1',
  prompt: 'A concise prompt',
  mode: 'generate' as const,
  model: 'gpt-image-2.6-sunburst' as const,
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

  it('restores animation settings from history and keeps them for image-to-GIF reuse', () => {
    const store = useImagePanelStore.getState();
    const params = {
      output_format: 'gif' as const,
      frame_count: 3,
      frame_duration_ms: 100,
      size: '256x256' as const,
    };
    store.setHistory([{ ...entry, params }]);
    store.restoreFromHistory(entry.id);
    expect(useImagePanelStore.getState().params).toMatchObject(params);
    store.reuseOutputAsInput({
      imageId: output.imageId,
      sessionId: 'generated',
      mimeType: 'image/gif',
    });
    const state = useImagePanelStore.getState();
    expect(state.mode).toBe('edit');
    expect(state.inputImages[0].mimeType).toBe('image/gif');
    expect(state.params).toMatchObject(params);
    store.setParam('output_format', 'png');
    expect(useImagePanelStore.getState().params).not.toHaveProperty(
      'frame_count',
    );
    expect(useImagePanelStore.getState().params).not.toHaveProperty('size');
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

  it('drops generate-only moderation when switching to edit mode', () => {
    const store = useImagePanelStore.getState();
    store.setParam('moderation', 'low');
    expect(useImagePanelStore.getState().params.moderation).toBe('low');

    store.setMode('edit');
    expect(useImagePanelStore.getState().params).not.toHaveProperty(
      'moderation',
    );
  });

  it('restores legacy history with the current model and preserves complexity for edits', () => {
    const store = useImagePanelStore.getState();
    store.setHistory([{ ...entry, model: 'gpt-image-2.5-sunburst' }]);
    store.restoreFromHistory(entry.id);
    expect(useImagePanelStore.getState().model).toBe('gpt-image-2.6-sunburst');
    expect(useImagePanelStore.getState().history[0].model).toBe(
      'gpt-image-2.5-sunburst',
    );
    store.setParam('complexity', 'low');
    store.setMode('edit');
    expect(useImagePanelStore.getState().params.complexity).toBe('low');
  });
});
