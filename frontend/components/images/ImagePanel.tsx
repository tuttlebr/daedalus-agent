'use client';

import React, { useCallback, useEffect } from 'react';

import { HistoryDrawer, HistoryToggleButton } from './HistoryDrawer';
import { ImagesCanvas } from './ImagesCanvas';
import { ImagesDock } from './ImagesDock';

import {
  useImagePanelStore,
  selectMode,
  type GalleryImage,
  type HistoryEntry,
  type ImageRef,
} from '@/state/imagePanelStore';

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

async function loadImageHistory(): Promise<HistoryEntry[]> {
  const res = await fetch('/api/images/history');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { history?: HistoryEntry[] };
  return Array.isArray(data.history) ? data.history : [];
}

async function persistImageHistory(entry: HistoryEntry): Promise<void> {
  const res = await fetch('/api/images/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export function ImagePanel({ onSendToChat }: ImagePanelProps) {
  // Subscribe only to state that drives rendering of THIS component. Volatile
  // values like prompt/params/inputImages are read via getState() at submit
  // time so prompt keystrokes don't re-render the panel or invalidate onSubmit.
  const gallery = useImagePanelStore((s) => s.gallery);
  const loading = useImagePanelStore((s) => s.loading);
  const error = useImagePanelStore((s) => s.error);
  const expectedCount = useImagePanelStore((s) => s.params.n ?? 1);
  const reuseOutputAsInput = useImagePanelStore((s) => s.reuseOutputAsInput);
  const removeFromGallery = useImagePanelStore((s) => s.removeFromGallery);
  const setHistory = useImagePanelStore((s) => s.setHistory);

  useEffect(() => {
    let cancelled = false;

    loadImageHistory()
      .then((history) => {
        if (!cancelled) setHistory(history);
      })
      .catch((e) => {
        console.warn('Failed to hydrate image history:', e);
      });

    return () => {
      cancelled = true;
    };
  }, [setHistory]);

  const submit = useCallback(async () => {
    const state = useImagePanelStore.getState();
    const {
      prompt,
      preserveList,
      params,
      inputImages,
      maskImage,
      setError,
      setLoading,
      setGallery,
      appendToHistory,
    } = state;
    const mode = selectMode(state);

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

      try {
        await persistImageHistory(entry);
      } catch (e) {
        console.warn('Failed to persist image history:', e);
      }

      const nextGallery: GalleryImage[] = data.imageIds.map((id) => ({
        imageId: id,
        prompt: data.prompt,
        mode,
      }));
      setGallery(nextGallery);
      appendToHistory(entry);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const reuseRef = useCallback(
    (ref: ImageRef) => reuseOutputAsInput(ref),
    [reuseOutputAsInput],
  );

  return (
    <div className="relative w-full h-full flex flex-col bg-neutral-950 text-neutral-100 overflow-hidden">
      <header className="flex-none safe-top flex items-center justify-between px-5 py-3 z-10">
        <h1 className="text-base font-semibold tracking-tight text-neutral-100">
          Images
        </h1>
        <HistoryToggleButton />
      </header>

      <div className="flex-1 min-h-0 relative">
        <ImagesCanvas
          images={gallery}
          loading={loading}
          expectedCount={expectedCount}
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

      <HistoryDrawer />
    </div>
  );
}
