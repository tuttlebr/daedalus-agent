import { getImageOutputMimeType } from '@/utils/app/imageModelCapabilities';

import type { Message } from '@/types/chat';

import type { GalleryImage } from './imagePanelStore';

import { create } from 'zustand';

type Attachment = NonNullable<Message['attachments']>[number];

/** One-shot handoff into the composer. Never submits a chat message. */
export const useImageChatDraftStore = create<{
  pending: Attachment | null;
  queue: (image: GalleryImage) => void;
  take: () => Attachment | null;
}>((set, get) => ({
  pending: null,
  queue: (image) =>
    set({
      pending: {
        type: 'image',
        content: `/api/generated-image/${image.imageId}`,
        imageRef: {
          imageId: image.imageId,
          sessionId: 'generated',
          mimeType: getImageOutputMimeType(image.params),
        },
        imageContext: image.imageContext ?? {
          originalPrompt: image.prompt,
          prompt: image.prompt,
          guidance: 'exact',
          params: image.params,
          inputImages: [],
          brief: {
            scene: '',
            subject: '',
            medium: '',
            composition: '',
            lighting: '',
            details: [],
            exact_text: [],
            changes: [],
            preserve: [],
            exclusions: [],
            intended_use: '',
            references: [],
            options: image.params,
          },
        },
      },
    }),
  take: () => {
    const pending = get().pending;
    set({ pending: null });
    return pending;
  },
}));
