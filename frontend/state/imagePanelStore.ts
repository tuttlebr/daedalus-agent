/**
 * Image Panel Store — Zustand-based state for the /v1/images/* dedicated panel.
 *
 * Holds the current prompt, parameters, input images (edit mode), mask,
 * preserve-list, gallery of returned images, and an in-session history
 * strip. The live UI state is local; ImagePanel hydrates and persists history
 * through the image history API.
 *
 * Mode and model are explicit so users can choose Generate or Edit before
 * attaching reference images, and so controls can follow model capabilities.
 */
import {
  DEFAULT_IMAGE_MODEL,
  cleanImageParamsForModel,
  resolveImageModel,
  type ImageMode,
  type ImageModel,
  type ImageParams,
} from '@/utils/app/imageModelCapabilities';

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export type {
  ImageBackground,
  ImageInputFidelity,
  ImageMode,
  ImageModel,
  ImageModeration,
  ImageOutputFormat,
  ImageParams,
  ImageQuality,
  ImageSize,
} from '@/utils/app/imageModelCapabilities';

export type GenerationStatus =
  | 'idle'
  | 'queued'
  | 'submitting'
  | 'generating'
  | 'finalizing';

export interface ImageRef {
  imageId: string;
  sessionId: string;
  userId?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
}

export interface GalleryImage {
  imageId: string;
  prompt: string;
  mode: ImageMode;
  model: ImageModel;
  params: ImageParams;
  createdAt: number;
  partial?: boolean;
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
  usage?: Record<string, unknown>;
}

export interface ImagePanelState {
  mode: ImageMode;
  model: ImageModel;
  prompt: string;
  params: ImageParams;
  inputImages: ImageRef[];
  maskImage: ImageRef | null;
  preserveList: string;
  gallery: GalleryImage[];
  partialGallery: GalleryImage[];
  selectedImageId: string | null;
  history: HistoryEntry[];
  loading: boolean;
  generationStatus: GenerationStatus;
  generationStartedAt: number | null;
  error: string | null;
  historyOpen: boolean;
}

export interface ImagePanelActions {
  setMode: (mode: ImageMode) => void;
  setModel: (model: ImageModel) => void;
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
  setPartialGallery: (images: GalleryImage[]) => void;
  setSelectedImageId: (imageId: string | null) => void;
  removeFromGallery: (imageId: string) => void;
  setHistory: (entries: HistoryEntry[]) => void;
  appendToHistory: (entry: HistoryEntry) => void;
  restoreFromHistory: (entryId: string) => void;
  removeFromHistory: (entryId: string) => void;
  clearHistory: () => void;

  setLoading: (loading: boolean) => void;
  setGenerationStatus: (
    status: GenerationStatus,
    startedAt?: number | null,
  ) => void;
  setError: (error: string | null) => void;

  setHistoryOpen: (open: boolean) => void;
  toggleHistory: () => void;

  clearAll: () => void;
}

export type ImagePanelStore = ImagePanelState & ImagePanelActions;

const DEFAULT_PARAMS: ImageParams = { quality: 'medium' };

const INITIAL_STATE: ImagePanelState = {
  mode: 'generate',
  model: DEFAULT_IMAGE_MODEL,
  prompt: '',
  params: { ...DEFAULT_PARAMS },
  inputImages: [],
  maskImage: null,
  preserveList: '',
  gallery: [],
  partialGallery: [],
  selectedImageId: null,
  history: [],
  loading: false,
  generationStatus: 'idle',
  generationStartedAt: null,
  error: null,
  historyOpen: false,
};

export const useImagePanelStore = create<ImagePanelStore>()(
  subscribeWithSelector((set, get) => ({
    ...INITIAL_STATE,

    setMode: (mode) => set({ mode, error: null }),
    setModel: (model) =>
      set((s) => ({
        model,
        params: cleanImageParamsForModel(s.params, model),
      })),
    setPrompt: (prompt) => set({ prompt }),
    setParam: (key, value) =>
      set((s) => ({
        params: cleanImageParamsForModel(
          value === undefined
            ? omit(s.params, key)
            : { ...s.params, [key]: value },
          s.model,
        ),
      })),
    resetParams: () =>
      set((s) => ({
        params: cleanImageParamsForModel(DEFAULT_PARAMS, s.model),
      })),

    addInputImages: (refs) =>
      set((s) => {
        const byId = new Map(s.inputImages.map((r) => [r.imageId, r]));
        for (const r of refs) byId.set(r.imageId, r);
        return { inputImages: Array.from(byId.values()), mode: 'edit' };
      }),
    removeInputImage: (imageId) =>
      set((s) => {
        const removedPrimary = s.inputImages[0]?.imageId === imageId;
        return {
          inputImages: s.inputImages.filter((r) => r.imageId !== imageId),
          // A mask is always tied to Image 1. If it changes, discard the
          // invalid pairing instead of letting users submit a broken edit.
          maskImage: removedPrimary ? null : s.maskImage,
        };
      }),
    clearInputImages: () => set({ inputImages: [], maskImage: null }),

    setMaskImage: (ref) => set({ maskImage: ref }),

    setPreserveList: (preserveList) => set({ preserveList }),

    reuseOutputAsInput: (ref) =>
      set((s) => {
        const byId = new Map(s.inputImages.map((r) => [r.imageId, r]));
        byId.set(ref.imageId, ref);
        return { inputImages: Array.from(byId.values()), mode: 'edit' };
      }),

    setGallery: (gallery) =>
      set((s) => ({
        gallery,
        partialGallery: [],
        selectedImageId:
          gallery[0]?.imageId ??
          (gallery.some((img) => img.imageId === s.selectedImageId)
            ? s.selectedImageId
            : null),
      })),
    setPartialGallery: (partialGallery) => set({ partialGallery }),
    setSelectedImageId: (selectedImageId) => set({ selectedImageId }),
    removeFromGallery: (imageId) =>
      set((s) => {
        const gallery = s.gallery.filter((g) => g.imageId !== imageId);
        return {
          gallery,
          selectedImageId:
            s.selectedImageId === imageId
              ? gallery[0]?.imageId ?? null
              : s.selectedImageId,
        };
      }),
    setHistory: (history) =>
      set((s) => {
        const nextHistory = history.slice(0, 50);
        const latest = nextHistory[0];
        const gallery =
          s.gallery.length === 0 && latest
            ? galleryFromHistoryEntry(latest)
            : s.gallery;
        return {
          history: nextHistory,
          gallery,
          selectedImageId: s.selectedImageId ?? gallery[0]?.imageId ?? null,
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
        mode: entry.mode,
        model: resolveEntryModel(entry.model),
        prompt: entry.prompt,
        params: cleanImageParamsForModel(entry.params, entry.model),
        inputImages: [...entry.inputImages],
        maskImage: entry.maskImage,
        gallery: galleryFromHistoryEntry(entry),
        partialGallery: [],
        selectedImageId: entry.outputImageIds[0] ?? null,
        error: null,
      });
    },
    removeFromHistory: (entryId) =>
      set((s) => ({ history: s.history.filter((e) => e.id !== entryId) })),
    clearHistory: () =>
      set({
        history: [],
      }),

    setLoading: (loading) => set({ loading }),
    setGenerationStatus: (generationStatus, generationStartedAt) =>
      set((s) => ({
        generationStatus,
        generationStartedAt:
          generationStartedAt === undefined
            ? s.generationStartedAt
            : generationStartedAt,
      })),
    setError: (error) => set({ error }),

    setHistoryOpen: (open) => set({ historyOpen: open }),
    toggleHistory: () => set((s) => ({ historyOpen: !s.historyOpen })),

    clearAll: () => set({ ...INITIAL_STATE, history: get().history }),
  })),
);

/** Select the explicit image workflow mode. */
export function selectMode(s: ImagePanelState): ImageMode {
  return s.mode;
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
    model: resolveEntryModel(entry.model),
    params: cleanImageParamsForModel(entry.params, entry.model),
    createdAt: entry.createdAt,
  }));
}

function resolveEntryModel(model: string): ImageModel {
  return resolveImageModel(model);
}
