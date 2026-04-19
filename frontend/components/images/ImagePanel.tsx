'use client';

import React, { useCallback, useMemo } from 'react';
import {
  useImagePanelStore,
  selectMode,
  type GalleryImage,
  type HistoryEntry,
  type ImageRef,
} from '@/state/imagePanelStore';
import { ImagesCanvas } from './ImagesCanvas';
import { ImagesDock } from './ImagesDock';
import { HistoryDrawer, HistoryToggleButton } from './HistoryDrawer';

interface ImagePanelProps {
  onSendToChat?: (imageId: string) => void;
}

function buildFinalPrompt(base: string, preserveList: string, mode: string): string {
  const trimmed = base.trim();
  if (mode !== 'edit' || !preserveList.trim()) return trimmed;
  return `${trimmed}\n\nKeep everything else the same, specifically: ${preserveList.trim()}.`;
}

function newEntryId(): string {
  return `hist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function ImagePanel({ onSendToChat }: ImagePanelProps) {
  const prompt = useImagePanelStore((s) => s.prompt);
  const params = useImagePanelStore((s) => s.params);
  const inputImages = useImagePanelStore((s) => s.inputImages);
  const maskImage = useImagePanelStore((s) => s.maskImage);
  const preserveList = useImagePanelStore((s) => s.preserveList);
  const gallery = useImagePanelStore((s) => s.gallery);
  const loading = useImagePanelStore((s) => s.loading);
  const error = useImagePanelStore((s) => s.error);
  const reuseOutputAsInput = useImagePanelStore((s) => s.reuseOutputAsInput);
  const setGallery = useImagePanelStore((s) => s.setGallery);
  const removeFromGallery = useImagePanelStore((s) => s.removeFromGallery);
  const appendToHistory = useImagePanelStore((s) => s.appendToHistory);
  const setLoading = useImagePanelStore((s) => s.setLoading);
  const setError = useImagePanelStore((s) => s.setError);
  const mode = useImagePanelStore(selectMode);

  const submit = useCallback(async () => {
    if (!prompt.trim()) {
      setError('Prompt is required');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const finalPrompt = buildFinalPrompt(prompt, preserveList, mode);
      const endpoint =
        mode === 'generate' ? '/api/images/generate' : '/api/images/edit';

      const body: Record<string, unknown> = { prompt: finalPrompt, ...params };
      if (mode === 'edit') {
        body.imageRefs = inputImages;
        if (maskImage) body.maskRef = maskImage;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        try {
          const json = JSON.parse(text);
          setError(json.detail ?? json.error ?? text);
        } catch {
          setError(text || `HTTP ${res.status}`);
        }
        return;
      }

      const data = (await res.json()) as {
        imageIds: string[];
        model: string;
        prompt: string;
      };

      const nextGallery: GalleryImage[] = data.imageIds.map((id) => ({
        imageId: id,
        prompt: data.prompt,
        mode,
      }));
      setGallery(nextGallery);

      const entry: HistoryEntry = {
        id: newEntryId(),
        mode,
        prompt: finalPrompt,
        params: { ...params },
        inputImages: [...inputImages],
        maskImage,
        outputImageIds: data.imageIds,
        model: data.model,
        createdAt: Date.now(),
      };
      appendToHistory(entry);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }, [
    prompt,
    mode,
    inputImages,
    preserveList,
    params,
    maskImage,
    setError,
    setLoading,
    setGallery,
    appendToHistory,
  ]);

  const reuseRef = useCallback(
    (ref: ImageRef) => reuseOutputAsInput(ref),
    [reuseOutputAsInput],
  );

  const submitDisabled = useMemo(() => {
    if (loading) return true;
    if (!prompt.trim()) return true;
    return false;
  }, [loading, prompt]);

  return (
    <div className="relative w-full h-full bg-neutral-950 text-neutral-100 overflow-hidden">
      {/* Top bar — title + history toggle */}
      <header className="absolute top-0 inset-x-0 z-10 flex items-center justify-between px-5 py-3">
        <h1 className="text-base font-semibold tracking-tight text-neutral-100">
          Images
        </h1>
        <HistoryToggleButton />
      </header>

      {/* Canvas area — grid-line backdrop + outputs. Top/bottom padding
          reserves room for the header and the floating dock. */}
      <div className="absolute inset-0 pt-14 pb-[148px]">
        <ImagesCanvas
          images={gallery}
          loading={loading}
          expectedCount={params.n ?? 1}
          onReuseAsInput={reuseRef}
          onSendToChat={onSendToChat}
          onDelete={removeFromGallery}
        />
      </div>

      {/* Error — small toast above the dock */}
      {error && (
        <div className="pointer-events-auto absolute bottom-[132px] inset-x-0 px-4 z-20">
          <div className="mx-auto max-w-3xl rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400 backdrop-blur">
            {error}
          </div>
        </div>
      )}

      {/* Docked prompt bar */}
      <ImagesDock onSubmit={submit} submitDisabled={submitDisabled} />

      {/* History side drawer */}
      <HistoryDrawer />
    </div>
  );
}
