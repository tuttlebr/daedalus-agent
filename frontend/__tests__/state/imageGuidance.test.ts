import { cleanMessagesForLLM } from '@/utils/app/imageHandler';

import { imageContext } from '../fixtures/imageContext';

import { useImageChatDraftStore } from '@/state/imageChatDraftStore';
import { useImagePanelStore, type GalleryImage } from '@/state/imagePanelStore';
import { beforeEach, describe, expect, it } from 'vitest';

const image: GalleryImage = {
  imageId: 'generated-bird',
  mode: 'generate',
  model: 'gpt-image-2.5-sunburst',
  createdAt: 1,
  prompt: imageContext.prompt,
  params: imageContext.params,
  imageContext,
};

describe('image guidance continuity', () => {
  beforeEach(() => {
    useImagePanelStore.getState().clearAll();
    useImagePanelStore.getState().setHistory([]);
    useImageChatDraftStore.getState().take();
  });

  it('stages an image once and includes its brief in the next chat request', () => {
    const drafts = useImageChatDraftStore.getState();
    drafts.queue(image);
    const attachment = drafts.take();
    expect(attachment?.imageRef).toEqual({
      imageId: image.imageId,
      sessionId: 'generated',
      mimeType: 'image/webp',
    });
    expect(attachment?.imageContext).toEqual(imageContext);
    expect(drafts.take()).toBeNull();
    const [message] = cleanMessagesForLLM([
      {
        role: 'user',
        content: 'Make the lighting warmer',
        attachments: [attachment!],
      },
    ]);
    expect(message.content).toContain('Make the lighting warmer');
    expect(message.content).toContain('the current request takes precedence');
    expect(message.content).toContain('watercolor');
    expect(message.content).toContain('generated-bird');
  });

  it('restores the original request and its own preservation list without duplicating the prepared prompt', () => {
    const store = useImagePanelStore.getState();
    store.setPreserveList('unrelated old constraint');
    store.setHistory([
      {
        id: 'run',
        mode: image.mode,
        model: image.model,
        prompt: image.prompt,
        params: image.params,
        inputImages: [],
        maskImage: null,
        outputImageIds: [image.imageId],
        createdAt: 1,
        imageContext,
      },
    ]);
    store.restoreFromHistory('run');
    expect(useImagePanelStore.getState().prompt).toBe(
      imageContext.originalPrompt,
    );
    expect(useImagePanelStore.getState().preserveList).toBe('palette');
    expect(useImagePanelStore.getState().gallery[0].imageContext).toEqual(
      imageContext,
    );
  });

  it('uses the selected result as Image 1 and clears a mask belonging to the old target', () => {
    const store = useImagePanelStore.getState();
    store.setGallery([image]);
    store.addInputImages([{ imageId: 'old-source', sessionId: 's' }]);
    store.setMaskImage({ imageId: 'old-mask', sessionId: 's' });
    store.setPrompt('old edit');
    store.reuseOutputAsInput({
      imageId: image.imageId,
      sessionId: 'generated',
    });
    const state = useImagePanelStore.getState();
    expect(state.inputImages.map((ref) => ref.imageId)).toEqual([
      image.imageId,
    ]);
    expect(state.maskImage).toBeNull();
    expect(state.prompt).toBe('');
    expect(state.params).toEqual({ ...imageContext.params, n: 1 });
  });
});
