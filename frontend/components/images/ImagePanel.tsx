'use client';

import React, { useCallback, useMemo } from 'react';
import { IconSparkles } from '@tabler/icons-react';
import { Button } from '@/components/primitives';
import {
  useImagePanelStore,
  type GalleryImage,
  type HistoryEntry,
  type ImageRef,
} from '@/state/imagePanelStore';
import { applyPreset, type ImagePreset } from '@/utils/app/imagePresets';
import { ModeToggle } from './ModeToggle';
import { PromptInput } from './PromptInput';
import { PresetChips } from './PresetChips';
import { ParameterPanel } from './ParameterPanel';
import { ImageUploadZone } from './ImageUploadZone';
import { MaskUpload } from './MaskUpload';
import { PreserveListInput } from './PreserveListInput';
import { GalleryGrid } from './GalleryGrid';
import { HistoryStrip } from './HistoryStrip';

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
  const {
    mode,
    prompt,
    params,
    inputImages,
    maskImage,
    preserveList,
    gallery,
    history,
    loading,
    error,
    setMode,
    setPrompt,
    setParam,
    addInputImages,
    removeInputImage,
    clearInputImages,
    setMaskImage,
    setPreserveList,
    reuseOutputAsInput,
    setGallery,
    appendToHistory,
    restoreFromHistory,
    setLoading,
    setError,
  } = useImagePanelStore();

  const handleApplyPreset = useCallback(
    (preset: ImagePreset) => {
      const { prompt: nextPrompt, preserveList: nextPreserve, params: nextParams } =
        applyPreset(preset, prompt);
      setPrompt(nextPrompt);
      if (nextPreserve !== undefined) setPreserveList(nextPreserve);
      // Merge preset params over current (preset wins for the keys it sets).
      Object.entries(nextParams).forEach(([k, v]) => {
        setParam(k as keyof typeof params, v as never);
      });
    },
    [prompt, setPrompt, setPreserveList, setParam, params],
  );

  const submit = useCallback(async () => {
    if (!prompt.trim()) {
      setError('Prompt is required');
      return;
    }
    if (mode === 'edit' && inputImages.length === 0) {
      setError('Upload at least one source image for edit mode');
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

  const submitDisabled = useMemo(() => {
    if (loading) return true;
    if (!prompt.trim()) return true;
    if (mode === 'edit' && inputImages.length === 0) return true;
    return false;
  }, [loading, prompt, mode, inputImages.length]);

  return (
    <div className="w-full h-full overflow-y-auto bg-white dark:bg-dark-bg-primary">
      <div className="max-w-6xl mx-auto px-6 py-6 flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
              Create New
            </h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
              Generate and edit images with the full OpenAI images API surface.
            </p>
          </div>
          <ModeToggle mode={mode} onChange={setMode} disabled={loading} />
        </div>

        {/* Two-column: inputs on left, outputs on right */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="flex flex-col gap-5">
            <PresetChips mode={mode} onApply={handleApplyPreset} />

            <PromptInput value={prompt} onChange={setPrompt} disabled={loading} />

            {mode === 'edit' && (
              <>
                <ImageUploadZone
                  images={inputImages}
                  onAdd={addInputImages}
                  onRemove={removeInputImage}
                  disabled={loading}
                />
                <MaskUpload
                  mask={maskImage}
                  onChange={setMaskImage}
                  disabled={loading}
                />
                <PreserveListInput
                  value={preserveList}
                  onChange={setPreserveList}
                  disabled={loading}
                />
              </>
            )}

            <ParameterPanel mode={mode} params={params} onChange={setParam} />

            <div className="flex items-center gap-3">
              <Button
                variant="accent"
                size="lg"
                isLoading={loading}
                onClick={submit}
                disabled={submitDisabled}
                leftIcon={<IconSparkles size={18} />}
              >
                {loading
                  ? mode === 'generate'
                    ? 'Generating…'
                    : 'Editing…'
                  : mode === 'generate'
                    ? 'Generate'
                    : 'Edit'}
              </Button>
              {mode === 'edit' && inputImages.length > 0 && (
                <Button variant="ghost" size="sm" onClick={clearInputImages}>
                  Clear inputs
                </Button>
              )}
            </div>

            {error && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
                {error}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-5">
            <label className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              Output
            </label>
            <GalleryGrid
              images={gallery}
              onReuseAsInput={reuseOutputAsInput}
              onSendToChat={onSendToChat}
            />
          </div>
        </div>

        <HistoryStrip history={history} onRestore={restoreFromHistory} />
      </div>
    </div>
  );
}

export type { ImageRef };
