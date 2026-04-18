/**
 * Image Panel Store — Zustand-based state for the /v1/images/* dedicated panel.
 *
 * Holds the current prompt, parameters, input images (edit mode), mask,
 * preserve-list, gallery of returned images, and an in-session history
 * strip. Ephemeral by design — not persisted across reloads.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export type ImageMode = 'generate' | 'edit';

export type ImageQuality = 'auto' | 'low' | 'medium' | 'high' | 'standard' | 'hd';
export type ImageSize =
  | 'auto'
  | '1024x1024'
  | '1024x1536'
  | '1536x1024'
  | '1792x1024'
  | '1024x1792';
export type ImageOutputFormat = 'png' | 'jpeg' | 'webp';
export type ImageBackground = 'transparent' | 'opaque' | 'auto';
export type ImageModeration = 'low' | 'auto';
export type ImageStyle = 'vivid' | 'natural';
export type ImageInputFidelity = 'low' | 'high';

export interface ImageParams {
  n?: number;
  quality?: ImageQuality;
  size?: ImageSize;
  output_format?: ImageOutputFormat;
  output_compression?: number;
  background?: ImageBackground;
  moderation?: ImageModeration;
  style?: ImageStyle;
  input_fidelity?: ImageInputFidelity;
}

export interface ImageRef {
  imageId: string;
  sessionId: string;
  userId?: string;
  mimeType?: string;
}

export interface GalleryImage {
  imageId: string;
  prompt: string;
  mode: ImageMode;
}

export interface HistoryEntry {
  id: string;
  mode: ImageMode;
  prompt: string;
  params: ImageParams;
  inputImages: ImageRef[];
  maskImage: ImageRef | null;
  outputImageIds: string[];
  model: string;
  createdAt: number;
}

export interface ImagePanelState {
  mode: ImageMode;
  prompt: string;
  params: ImageParams;
  inputImages: ImageRef[];
  maskImage: ImageRef | null;
  preserveList: string;
  gallery: GalleryImage[];
  history: HistoryEntry[];
  loading: boolean;
  error: string | null;
}

export interface ImagePanelActions {
  setMode: (mode: ImageMode) => void;
  setPrompt: (prompt: string) => void;
  setParam: <K extends keyof ImageParams>(key: K, value: ImageParams[K]) => void;
  resetParams: () => void;

  addInputImages: (refs: ImageRef[]) => void;
  removeInputImage: (imageId: string) => void;
  clearInputImages: () => void;

  setMaskImage: (ref: ImageRef | null) => void;

  setPreserveList: (text: string) => void;

  reuseOutputAsInput: (ref: ImageRef) => void;

  setGallery: (images: GalleryImage[]) => void;
  appendToHistory: (entry: HistoryEntry) => void;
  restoreFromHistory: (entryId: string) => void;

  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  clearAll: () => void;
}

export type ImagePanelStore = ImagePanelState & ImagePanelActions;

const DEFAULT_PARAMS: ImageParams = {};

const INITIAL_STATE: ImagePanelState = {
  mode: 'generate',
  prompt: '',
  params: { ...DEFAULT_PARAMS },
  inputImages: [],
  maskImage: null,
  preserveList: '',
  gallery: [],
  history: [],
  loading: false,
  error: null,
};

export const useImagePanelStore = create<ImagePanelStore>()(
  subscribeWithSelector((set, get) => ({
    ...INITIAL_STATE,

    setMode: (mode) => set({ mode, error: null }),
    setPrompt: (prompt) => set({ prompt }),
    setParam: (key, value) =>
      set((s) => ({
        params: value === undefined ? omit(s.params, key) : { ...s.params, [key]: value },
      })),
    resetParams: () => set({ params: { ...DEFAULT_PARAMS } }),

    addInputImages: (refs) =>
      set((s) => {
        const byId = new Map(s.inputImages.map((r) => [r.imageId, r]));
        for (const r of refs) byId.set(r.imageId, r);
        return { inputImages: Array.from(byId.values()) };
      }),
    removeInputImage: (imageId) =>
      set((s) => ({
        inputImages: s.inputImages.filter((r) => r.imageId !== imageId),
      })),
    clearInputImages: () => set({ inputImages: [], maskImage: null }),

    setMaskImage: (ref) => set({ maskImage: ref }),

    setPreserveList: (preserveList) => set({ preserveList }),

    reuseOutputAsInput: (ref) =>
      set((s) => {
        const byId = new Map(s.inputImages.map((r) => [r.imageId, r]));
        byId.set(ref.imageId, ref);
        return {
          mode: 'edit',
          inputImages: Array.from(byId.values()),
        };
      }),

    setGallery: (gallery) => set({ gallery }),
    appendToHistory: (entry) =>
      set((s) => ({ history: [entry, ...s.history].slice(0, 50) })),
    restoreFromHistory: (entryId) => {
      const entry = get().history.find((e) => e.id === entryId);
      if (!entry) return;
      set({
        mode: entry.mode,
        prompt: entry.prompt,
        params: { ...entry.params },
        inputImages: [...entry.inputImages],
        maskImage: entry.maskImage,
        error: null,
      });
    },

    setLoading: (loading) => set({ loading }),
    setError: (error) => set({ error }),

    clearAll: () => set({ ...INITIAL_STATE, history: get().history }),
  })),
);

function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const { [key]: _omitted, ...rest } = obj;
  return rest;
}
