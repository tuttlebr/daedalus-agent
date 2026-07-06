'use client';

import {
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconMessage,
  IconTrash,
} from '@tabler/icons-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { getImageUrl } from '@/utils/app/imageHandler';
import {
  cleanImageParamsForModel,
  resolveImageModel,
  validateImageParamsForSubmit,
} from '@/utils/app/imageModelCapabilities';
import {
  useImageHistory,
  useInvalidateImageHistory,
} from '@/utils/app/queries';

import { EditAssetsPanel } from './AttachmentsPopover';
import { HistoryDrawer, HistoryToggleButton } from './HistoryDrawer';
import { ImageSettingsPanel } from './ImageSettingsPanel';
import { ImagesCanvas } from './ImagesCanvas';
import { ImagesDock } from './ImagesDock';
import { ModeSegmentedControl } from './ModeSegmentedControl';

import {
  useImagePanelStore,
  selectMode,
  type GalleryImage,
  type HistoryEntry,
  type ImageRef,
} from '@/state/imagePanelStore';
import classNames from 'classnames';

const GENERATED_SESSION_ID = 'generated';

interface ImagePanelProps {
  onSendToChat?: (imageId: string) => void;
}

function buildFinalPrompt(
  base: string,
  preserveList: string,
  mode: string,
): string {
  const trimmed = base.trim();
  if (mode !== 'edit' || !preserveList.trim()) return trimmed;
  return `${trimmed}\n\nKeep everything else the same, specifically: ${preserveList.trim()}.`;
}

function newEntryId(): string {
  return `hist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

interface ImageGenerationResponse {
  imageIds: string[];
  model?: string;
  prompt?: string;
  usage?: Record<string, unknown>;
}

export async function loadImageHistory(): Promise<HistoryEntry[]> {
  const res = await fetch('/api/images/history', { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { history?: HistoryEntry[] };
  return Array.isArray(data.history) ? data.history : [];
}

async function persistImageHistory(entry: HistoryEntry): Promise<void> {
  const res = await fetch('/api/images/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry }),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function readImageGenerationResponse(
  res: Response,
  onPartial: (imageIds: string[]) => void,
): Promise<ImageGenerationResponse> {
  const contentType = res.headers.get('content-type') ?? '';
  if (
    !res.body ||
    (!contentType.includes('text/event-stream') &&
      !contentType.includes('application/x-ndjson'))
  ) {
    return (await res.json()) as ImageGenerationResponse;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: ImageGenerationResponse | null = null;
  const boundaryToken = contentType.includes('application/x-ndjson')
    ? '\n'
    : '\n\n';

  const handleEvent = (raw: string) => {
    const payload = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('event:'))
      .map((line) => line.replace(/^data:\s*/, ''))
      .join('');
    if (!payload || payload === '[DONE]') return;
    try {
      const event = JSON.parse(payload) as ImageGenerationResponse & {
        type?: string;
        event?: string;
        imageId?: string;
        error?: string;
      };
      const type = event.type ?? event.event;
      if (type === 'error') {
        throw new Error(
          typeof event.error === 'string'
            ? event.error
            : 'Image generation stream failed.',
        );
      }
      const imageIds = event.imageIds ?? (event.imageId ? [event.imageId] : []);
      if (type === 'partial' && imageIds.length > 0) {
        onPartial(imageIds);
        return;
      }
      if (type === 'completed' || imageIds.length > 0) {
        completed = event;
      }
    } catch {
      // Ignore malformed stream fragments and wait for the completed event.
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    let boundary = buffer.indexOf(boundaryToken);
    while (boundary >= 0) {
      handleEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + boundaryToken.length);
      boundary = buffer.indexOf(boundaryToken);
    }

    if (done) break;
  }

  if (buffer.trim()) handleEvent(buffer);
  if (completed) return completed;
  throw new Error('Image generation stream ended without a completed event.');
}

function generatedRef(imageId: string, mimeType = 'image/png'): ImageRef {
  return { imageId, sessionId: GENERATED_SESSION_ID, mimeType };
}

function downloadExtensionForImage(image: GalleryImage): string {
  return image.params.output_format === 'jpeg'
    ? 'jpg'
    : image.params.output_format ?? 'png';
}

async function imageApiErrorMessage(res: Response): Promise<string> {
  const fallback =
    res.status === 504
      ? 'Backend timed out. Try again with the same prompt or fewer outputs.'
      : res.status === 502
      ? 'Backend unavailable. Try again when the image service is reachable.'
      : `HTTP ${res.status}`;

  const text = await res.text();
  if (!text) return fallback;
  try {
    const json = JSON.parse(text) as {
      detail?: string;
      error?: string;
      message?: string;
    };
    return json.detail ?? json.error ?? json.message ?? fallback;
  } catch {
    return text || fallback;
  }
}

function useElapsedMs(active: boolean, startedAt: number | null): number {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!active || !startedAt) {
      setElapsedMs(0);
      return;
    }
    setElapsedMs(Date.now() - startedAt);
    const interval = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 500);
    return () => window.clearInterval(interval);
  }, [active, startedAt]);

  return elapsedMs;
}

export function ImagePanel({ onSendToChat }: ImagePanelProps) {
  // Subscribe only to state that drives rendering of THIS component. Volatile
  // values like prompt/params/inputImages are read via getState() at submit
  // time so prompt keystrokes don't re-render the panel or invalidate onSubmit.
  const gallery = useImagePanelStore((s) => s.gallery);
  const partialGallery = useImagePanelStore((s) => s.partialGallery);
  const loading = useImagePanelStore((s) => s.loading);
  const generationStatus = useImagePanelStore((s) => s.generationStatus);
  const generationStartedAt = useImagePanelStore((s) => s.generationStartedAt);
  const error = useImagePanelStore((s) => s.error);
  const expectedCount = useImagePanelStore((s) => s.params.n ?? 1);
  const mode = useImagePanelStore(selectMode);
  const selectedImageId = useImagePanelStore((s) => s.selectedImageId);
  const reuseOutputAsInput = useImagePanelStore((s) => s.reuseOutputAsInput);
  const removeFromGallery = useImagePanelStore((s) => s.removeFromGallery);
  const setSelectedImageId = useImagePanelStore((s) => s.setSelectedImageId);
  const setHistory = useImagePanelStore((s) => s.setHistory);
  const { data: historyData } = useImageHistory();
  const invalidateImageHistory = useInvalidateImageHistory();
  const elapsedMs = useElapsedMs(loading, generationStartedAt);

  useEffect(() => {
    if (historyData) setHistory(historyData);
  }, [historyData, setHistory]);

  const displayImages = partialGallery.length > 0 ? partialGallery : gallery;
  const selectedImage = useMemo(
    () => gallery.find((image) => image.imageId === selectedImageId) ?? null,
    [gallery, selectedImageId],
  );

  const submit = useCallback(async () => {
    const state = useImagePanelStore.getState();
    const {
      prompt,
      preserveList,
      params,
      inputImages,
      maskImage,
      model,
      setError,
      setLoading,
      setGenerationStatus,
      setGallery,
      setPartialGallery,
      appendToHistory,
    } = state;
    const mode = selectMode(state);

    if (!prompt.trim()) {
      setError('Prompt is required');
      return;
    }
    if (mode === 'edit' && inputImages.length === 0) {
      setError('Add at least one input image or switch to Generate.');
      return;
    }
    const paramsValidation = validateImageParamsForSubmit(params, model);
    if (!paramsValidation.valid) {
      setError(paramsValidation.reason ?? 'Invalid image size');
      return;
    }

    setError(null);
    setLoading(true);
    setPartialGallery([]);
    setGenerationStatus('queued', Date.now());
    try {
      const finalPrompt = buildFinalPrompt(prompt, preserveList, mode);
      const endpoint =
        mode === 'generate' ? '/api/images/generate' : '/api/images/edit';
      const cleanedParams = cleanImageParamsForModel(params, model);

      const body: Record<string, unknown> = {
        prompt: finalPrompt,
        model,
        ...cleanedParams,
      };
      if (mode === 'edit') {
        body.imageRefs = inputImages;
        if (maskImage) body.maskRef = maskImage;
      }

      setGenerationStatus('submitting');
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setGenerationStatus('generating');

      if (!res.ok) {
        setError(await imageApiErrorMessage(res));
        return;
      }

      const data = await readImageGenerationResponse(res, (imageIds) => {
        setPartialGallery(
          imageIds.map((id) => ({
            imageId: id,
            prompt: finalPrompt,
            mode,
            model,
            params: cleanedParams,
            createdAt: Date.now(),
            partial: true,
          })),
        );
      });
      setGenerationStatus('finalizing');
      if (!Array.isArray(data.imageIds) || data.imageIds.length === 0) {
        throw new Error('Image response did not include generated image IDs.');
      }

      const responseModel = data.model ?? model;
      const galleryModel = resolveImageModel(responseModel);

      const entry: HistoryEntry = {
        id: newEntryId(),
        mode,
        prompt: finalPrompt,
        params: { ...cleanedParams },
        inputImages: [...inputImages],
        maskImage,
        outputImageIds: data.imageIds,
        model: responseModel,
        createdAt: Date.now(),
        usage: data.usage,
      };

      try {
        await persistImageHistory(entry);
        invalidateImageHistory();
      } catch (e) {
        console.warn('Failed to persist image history:', e);
      }

      const nextGallery: GalleryImage[] = data.imageIds.map((id) => ({
        imageId: id,
        prompt: data.prompt ?? finalPrompt,
        mode,
        model: galleryModel,
        params: cleanedParams,
        createdAt: entry.createdAt,
      }));
      setGallery(nextGallery);
      appendToHistory(entry);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setLoading(false);
      setGenerationStatus('idle', null);
    }
  }, [invalidateImageHistory]);

  const reuseRef = useCallback(
    (ref: ImageRef) => reuseOutputAsInput(ref),
    [reuseOutputAsInput],
  );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      <header className="z-10 grid flex-none grid-cols-[1fr_auto] items-center gap-2 px-3 py-2 safe-top md:flex md:justify-between md:gap-3 md:px-5 md:py-3">
        <h1 className="text-base font-semibold tracking-tight text-neutral-100">
          Create New
        </h1>
        <div className="order-3 col-span-2 justify-self-center md:order-none md:col-span-1">
          <ModeSegmentedControl />
        </div>
        <HistoryToggleButton />
      </header>

      <div className="relative flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          {mode === 'edit' && (
            <div className="hidden flex-none md:block">
              <EditAssetsPanel disabled={loading} />
            </div>
          )}

          <div className="relative min-h-0 flex-1">
            <ImagesCanvas
              images={displayImages}
              loading={loading}
              expectedCount={expectedCount}
              generationStatus={generationStatus}
              elapsedMs={elapsedMs}
              selectedImageId={selectedImageId}
              onSelectImage={setSelectedImageId}
              onReuseAsInput={reuseRef}
              onSendToChat={onSendToChat}
              onDelete={removeFromGallery}
            />
          </div>

          {error && (
            <div className="flex-none px-4 pb-1">
              <div className="mx-auto max-w-3xl rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400 backdrop-blur">
                {error}
              </div>
            </div>
          )}

          <ImagesDock onSubmit={submit} />
        </main>

        <aside className="hidden w-[360px] flex-none flex-col border-l border-white/10 bg-neutral-950/90 lg:flex">
          <div className="min-h-0 flex-1">
            <ImageSettingsPanel />
          </div>
          <OutputDetailPanel
            image={selectedImage}
            onReuseAsInput={reuseRef}
            onSendToChat={onSendToChat}
            onDelete={removeFromGallery}
          />
        </aside>
      </div>

      <HistoryDrawer />
    </div>
  );
}

function OutputDetailPanel({
  image,
  onReuseAsInput,
  onSendToChat,
  onDelete,
}: {
  image: GalleryImage | null;
  onReuseAsInput: (ref: ImageRef) => void;
  onSendToChat?: (imageId: string) => void;
  onDelete: (imageId: string) => void;
}) {
  if (!image) {
    return (
      <div className="border-t border-white/10 p-4 text-xs text-neutral-600">
        Select an output to inspect its prompt, params, and actions.
      </div>
    );
  }

  const ref = generatedRef(image.imageId);
  const fullUrl = getImageUrl(ref, false);
  const download = async () => {
    let url: string | null = null;
    try {
      const res = await fetch(fullUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${image.imageId}.${downloadExtensionForImage(image)}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="max-h-[44vh] overflow-y-auto border-t border-white/10 p-4">
      <div className="mb-3 text-sm font-medium text-neutral-100">
        Output Detail
      </div>
      <div className="mb-3 overflow-hidden rounded-lg bg-neutral-900 ring-1 ring-white/10">
        <img
          src={fullUrl}
          alt={image.prompt}
          className="h-40 w-full object-contain"
        />
      </div>
      <div className="mb-3 flex flex-wrap gap-1">
        <OutputAction
          icon={<IconEdit size={14} />}
          onClick={() => onReuseAsInput(ref)}
        >
          Reuse
        </OutputAction>
        {onSendToChat && (
          <OutputAction
            icon={<IconMessage size={14} />}
            onClick={() => onSendToChat(image.imageId)}
          >
            Chat
          </OutputAction>
        )}
        <OutputAction icon={<IconDownload size={14} />} onClick={download}>
          Download
        </OutputAction>
        <OutputAction
          icon={<IconExternalLink size={14} />}
          onClick={() => window.open(fullUrl, '_blank', 'noopener')}
        >
          Open
        </OutputAction>
        <OutputAction
          icon={<IconTrash size={14} />}
          danger
          onClick={() => onDelete(image.imageId)}
        >
          Remove
        </OutputAction>
      </div>
      <OutputMeta label="Prompt">{image.prompt}</OutputMeta>
      <OutputMeta label="Model">{image.model}</OutputMeta>
      <OutputMeta label="Params">
        {JSON.stringify(image.params, null, 2)}
      </OutputMeta>
    </div>
  );
}

function OutputAction({
  icon,
  children,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={classNames(
        'inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs transition-colors',
        danger
          ? 'border-red-500/20 text-red-300 hover:bg-red-500/10'
          : 'border-white/10 text-neutral-300 hover:bg-white/5 hover:text-neutral-100',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function OutputMeta({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      <div className="whitespace-pre-wrap break-words rounded-md bg-black/25 p-2 text-[11px] leading-relaxed text-neutral-300">
        {children}
      </div>
    </div>
  );
}
