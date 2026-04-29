/**
 * Image Panel Store — Zustand-based state for the /v1/images/* dedicated panel.
 *
 * Holds the current prompt, parameters, input images (edit mode), mask,
 * preserve-list, gallery of returned images, and an in-session history
 * strip. The live UI state is local; ImagePanel hydrates and persists history
 * through the image history API.
 *
 * Mode is derived, not stored: anything with attached inputImages is an
 * edit; anything without is a generate.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export type ImageMode = 'generate' | 'edit';

export type ImageQuality = 'auto' | 'low' | 'medium' | 'high';
export type ImageSize = 'auto' | '1024x1024' | '1024x1536' | '1536x1024';
export type ImageOutputFormat = 'png' | 'jpeg' | 'webp';
export type ImageBackground = 'transparent' | 'opaque' | 'auto';
export type ImageModeration = 'low' | 'auto';
export type ImageInputFidelity = 'low' | 'high';

export interface ImageParams {
  n?: number;
  quality?: ImageQuality;
  size?: ImageSize;
  output_format?: ImageOutputFormat;
  output_compression?: number;
  background?: ImageBackground;
  moderation?: ImageModeration;
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
  prompt: string;
  params: ImageParams;
  inputImages: ImageRef[];
  maskImage: ImageRef | null;
  preserveList: string;
  gallery: GalleryImage[];
  history: HistoryEntry[];
  loading: boolean;
  error: string | null;
  historyOpen: boolean;
}

export interface ImagePanelActions {
  setPrompt: (prompt: string) => void;
  setParam: <K extends keyof ImageParams>(
    key: K,
    value: ImageParams[K],
  ) => void;
  resetParams: () => void;

  addInputImages: (refs: ImageRef[]) => void;
  removeInputImage: (imageId: string) => void;
  clearInputImages: () => void;

  setMaskImage: (ref: ImageRef | null) => void;

  setPreserveList: (text: string) => void;

  reuseOutputAsInput: (ref: ImageRef) => void;

  setGallery: (images: GalleryImage[]) => void;
  removeFromGallery: (imageId: string) => void;
  setHistory: (entries: HistoryEntry[]) => void;
  appendToHistory: (entry: HistoryEntry) => void;
  restoreFromHistory: (entryId: string) => void;
  removeFromHistory: (entryId: string) => void;
  clearHistory: () => void;

  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  setHistoryOpen: (open: boolean) => void;
  toggleHistory: () => void;

  clearAll: () => void;
}

export type ImagePanelStore = ImagePanelState & ImagePanelActions;

const DEFAULT_PARAMS: ImageParams = { quality: 'medium' };

const INITIAL_STATE: ImagePanelState = {
  prompt: '',
  params: { ...DEFAULT_PARAMS },
  inputImages: [],
  maskImage: null,
  preserveList: '',
  gallery: [],
  history: [],
  loading: false,
  error: null,
  historyOpen: false,
};

export const useImagePanelStore = create<ImagePanelStore>()(
  subscribeWithSelector((set, get) => ({
    ...INITIAL_STATE,

    setPrompt: (prompt) => set({ prompt }),
    setParam: (key, value) =>
      set((s) => ({
        params:
          value === undefined
            ? omit(s.params, key)
            : { ...s.params, [key]: value },
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
        return { inputImages: Array.from(byId.values()) };
      }),

    setGallery: (gallery) => set({ gallery }),
    removeFromGallery: (imageId) =>
      set((s) => ({ gallery: s.gallery.filter((g) => g.imageId !== imageId) })),
    setHistory: (history) =>
      set((s) => {
        const nextHistory = history.slice(0, 50);
        const latest = nextHistory[0];
        return {
          history: nextHistory,
          gallery:
            s.gallery.length === 0 && latest
              ? galleryFromHistoryEntry(latest)
              : s.gallery,
        };
      }),
    appendToHistory: (entry) =>
      set((s) => ({
        history: [
          entry,
          ...s.history.filter((item) => item.id !== entry.id),
        ].slice(0, 50),
      })),
    restoreFromHistory: (entryId) => {
      const entry = get().history.find((e) => e.id === entryId);
      if (!entry) return;
      set({
        prompt: entry.prompt,
        params: { ...entry.params },
        inputImages: [...entry.inputImages],
        maskImage: entry.maskImage,
        gallery: galleryFromHistoryEntry(entry),
        error: null,
      });
    },
    removeFromHistory: (entryId) =>
      set((s) => {
        const removed = s.history.find((e) => e.id === entryId);
        const nextHistory = s.history.filter((e) => e.id !== entryId);
        const galleryFromThis =
          !!removed &&
          s.gallery.length > 0 &&
          s.gallery.length === removed.outputImageIds.length &&
          s.gallery.every((g, i) => g.imageId === removed.outputImageIds[i]);
        return {
          history: nextHistory,
          gallery: galleryFromThis ? [] : s.gallery,
        };
      }),
    clearHistory: () => set({ history: [], gallery: [] }),

    setLoading: (loading) => set({ loading }),
    setError: (error) => set({ error }),

    setHistoryOpen: (open) => set({ historyOpen: open }),
    toggleHistory: () => set((s) => ({ historyOpen: !s.historyOpen })),

    clearAll: () => set({ ...INITIAL_STATE, history: get().history }),
  })),
);

/** Derive mode from attachments — if any images are attached, we're editing. */
export function selectMode(s: ImagePanelState): ImageMode {
  return s.inputImages.length > 0 ? 'edit' : 'generate';
}

function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const { [key]: _omitted, ...rest } = obj;
  return rest;
}

function galleryFromHistoryEntry(entry: HistoryEntry): GalleryImage[] {
  return entry.outputImageIds.map((imageId) => ({
    imageId,
    prompt: entry.prompt,
    mode: entry.mode,
  }));
}
