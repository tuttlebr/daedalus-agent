'use client';

import {
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconMessage,
  IconTrash,
} from '@tabler/icons-react';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useIsDesktop } from '@/hooks/useMediaQuery';

import { getImageUrl } from '@/utils/app/imageHandler';
import {
  cleanImageParamsForModel,
  getImageOutputMimeType,
  resolveImageModel,
  validateImageParamsForSubmit,
} from '@/utils/app/imageModelCapabilities';
import {
  useImageHistory,
  useInvalidateImageHistory,
} from '@/utils/app/queries';

import type { ImageContext } from '@/types/imageBrief';

import { EditAssetsPanel } from './AttachmentsPopover';
import { HistoryDrawer, HistoryToggleButton } from './HistoryDrawer';
import { ImageDownloadAction } from './ImageDownloadAction';
import { ImagePromptDetail } from './ImagePromptDetail';
import { ImageSettingsPanel } from './ImageSettingsPanel';
import { ImagesCanvas } from './ImagesCanvas';
import { ImagesDock } from './ImagesDock';
import { ModeSegmentedControl } from './ModeSegmentedControl';
import { OutputActionSheet } from './OutputActionSheet';

import {
  useImagePanelStore,
  selectMode,
  type GalleryImage,
  type HistoryEntry,
  type ImageRef,
} from '@/state/imagePanelStore';
import classNames from 'classnames';
import { v4 as uuidv4 } from 'uuid';

const GENERATED_SESSION_ID = 'generated';
const ACTIVE_IMAGE_JOBS_KEY = 'daedalus:active-image-jobs';
const IMAGE_JOB_STATUS_ATTEMPTS = 3;

interface ImageOperation {
  controller?: AbortController;
  submissionId?: string;
  jobId?: string;
  cancelRequested: boolean;
}

interface ImagePanelProps {
  onSendToChat?: (imageId: string) => void;
}

interface ImageJobStatus {
  imageContext?: ImageContext;
  jobId: string;
  sessionId: string;
  mode: 'generate' | 'edit';
  status: 'queued' | 'running' | 'completed' | 'error' | 'cancelled';
  prompt: string;
  model: string;
  params: Record<string, unknown>;
  inputImages: ImageRef[];
  maskImage: ImageRef | null;
  partialImageIds: string[];
  outputImageIds: string[];
  usage?: Record<string, unknown>;
  error?: string;
  historyEntry?: HistoryEntry;
  createdAt: number;
  completedAt?: number;
}

export async function loadImageHistory(): Promise<HistoryEntry[]> {
  const res = await fetch('/api/images/history', { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { history?: HistoryEntry[] };
  return Array.isArray(data.history) ? data.history : [];
}

function generatedRef(
  image: Pick<GalleryImage, 'imageId' | 'params'>,
): ImageRef {
  return {
    imageId: image.imageId,
    sessionId: GENERATED_SESSION_ID,
    mimeType: getImageOutputMimeType(image.params),
  };
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

function rememberActiveImageJob(jobId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const existing = JSON.parse(
      window.localStorage.getItem(ACTIVE_IMAGE_JOBS_KEY) || '[]',
    );
    const ids = Array.isArray(existing)
      ? existing.filter((id): id is string => typeof id === 'string')
      : [];
    window.localStorage.setItem(
      ACTIVE_IMAGE_JOBS_KEY,
      JSON.stringify([jobId, ...ids.filter((id) => id !== jobId)].slice(0, 5)),
    );
  } catch {
    // localStorage can be disabled; server-side job tracking still works.
  }
}

function forgetActiveImageJob(jobId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const existing = JSON.parse(
      window.localStorage.getItem(ACTIVE_IMAGE_JOBS_KEY) || '[]',
    );
    const ids = Array.isArray(existing)
      ? existing.filter((id): id is string => typeof id === 'string')
      : [];
    window.localStorage.setItem(
      ACTIVE_IMAGE_JOBS_KEY,
      JSON.stringify(ids.filter((id) => id !== jobId)),
    );
  } catch {
    // localStorage can be disabled; nothing to clean up.
  }
}

function rememberedImageJobIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const existing = JSON.parse(
      window.localStorage.getItem(ACTIVE_IMAGE_JOBS_KEY) || '[]',
    );
    return Array.isArray(existing)
      ? existing.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function startImageJob(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch('/api/images/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
    signal,
  });
  if (!res.ok) throw new Error(await imageApiErrorMessage(res));
  const data = (await res.json()) as { jobId?: string };
  if (!data.jobId) throw new Error('Image job response did not include jobId.');
  return data.jobId;
}

async function fetchImageJob(jobId: string): Promise<ImageJobStatus | null> {
  const res = await fetch(
    `/api/images/jobs?jobId=${encodeURIComponent(jobId)}`,
    {
      credentials: 'include',
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await imageApiErrorMessage(res));
  return (await res.json()) as ImageJobStatus;
}

/**
 * A mobile radio handoff can interrupt one status request even though the
 * background job is still healthy. Retry before surfacing that connection
 * problem, while keeping a 404 distinct so expired jobs do not spin forever.
 */
async function fetchImageJobWithRetry(
  jobId: string,
): Promise<ImageJobStatus | null> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < IMAGE_JOB_STATUS_ATTEMPTS; attempt += 1) {
    try {
      return await fetchImageJob(jobId);
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error('Unable to check image job');
      if (attempt < IMAGE_JOB_STATUS_ATTEMPTS - 1) {
        await delay(1_000 * (attempt + 1));
      }
    }
  }

  throw lastError ?? new Error('Unable to check image job');
}

async function fetchActiveImageJobs(): Promise<ImageJobStatus[]> {
  const res = await fetch('/api/images/jobs?active=1', {
    credentials: 'include',
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { jobs?: ImageJobStatus[] };
  return Array.isArray(data.jobs) ? data.jobs : [];
}

function galleryFromJob(
  job: ImageJobStatus,
  imageIds: string[],
  partial = false,
): GalleryImage[] {
  const model = resolveImageModel(job.model);
  const createdAt = job.completedAt ?? Date.now();
  return imageIds.map((imageId) => ({
    imageId,
    prompt: job.prompt,
    imageContext: job.imageContext,
    mode: job.mode,
    model,
    params: cleanImageParamsForModel(job.params, model, job.mode),
    createdAt,
    ...(partial && { partial: true }),
  }));
}

function historyEntryFromJob(job: ImageJobStatus): HistoryEntry {
  return {
    id: `hist_${job.completedAt ?? Date.now()}_${job.jobId.slice(0, 8)}`,
    mode: job.mode,
    prompt: job.prompt,
    imageContext: job.imageContext,
    params: cleanImageParamsForModel(job.params, job.model, job.mode),
    inputImages: job.inputImages,
    maskImage: job.maskImage,
    outputImageIds: job.outputImageIds,
    model: job.model,
    createdAt: job.completedAt ?? Date.now(),
    usage: job.usage,
  };
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
  const inputCount = useImagePanelStore((s) => s.inputImages.length);
  const reuseOutputAsInput = useImagePanelStore((s) => s.reuseOutputAsInput);
  const removeFromGallery = useImagePanelStore((s) => s.removeFromGallery);
  const setSelectedImageId = useImagePanelStore((s) => s.setSelectedImageId);
  const setHistory = useImagePanelStore((s) => s.setHistory);
  const { data: historyData } = useImageHistory();
  const invalidateImageHistory = useInvalidateImageHistory();
  const elapsedMs = useElapsedMs(loading, generationStartedAt);
  const operationRef = useRef<ImageOperation | null>(null);
  const stoppingRef = useRef(false);
  const isDesktop = useIsDesktop();
  const [outputActionsOpen, setOutputActionsOpen] = useState(false);
  const [recoverableJobId, setRecoverableJobId] = useState<string | null>(null);

  useEffect(() => {
    if (historyData) setHistory(historyData);
  }, [historyData, setHistory]);

  const displayImages = partialGallery.length > 0 ? partialGallery : gallery;
  const selectedImage = useMemo(
    () => gallery.find((image) => image.imageId === selectedImageId) ?? null,
    [gallery, selectedImageId],
  );

  useEffect(() => {
    if (!selectedImage) setOutputActionsOpen(false);
  }, [selectedImage]);

  const applyCompletedJob = useCallback(
    (job: ImageJobStatus) => {
      if (!job.outputImageIds.length) {
        throw new Error('Image response did not include generated image IDs.');
      }
      const entry = job.historyEntry ?? historyEntryFromJob(job);
      useImagePanelStore
        .getState()
        .setGallery(galleryFromJob(job, job.outputImageIds));
      useImagePanelStore.getState().appendToHistory(entry);
      invalidateImageHistory();
    },
    [invalidateImageHistory],
  );

  const pollImageJob = useCallback(
    async (
      jobId: string,
      initialStatus?: ImageJobStatus | null,
      operation: ImageOperation = { jobId, cancelRequested: false },
    ) => {
      operation.jobId = jobId;
      operationRef.current = operation;
      rememberActiveImageJob(jobId);
      const { setError, setLoading, setGenerationStatus, setPartialGallery } =
        useImagePanelStore.getState();
      setError(null);
      setLoading(true);
      setRecoverableJobId(null);

      let status = initialStatus ?? null;
      let shouldForgetJob = false;
      try {
        while (operationRef.current === operation) {
          status = status ?? (await fetchImageJobWithRetry(jobId));
          if (operationRef.current !== operation) return;
          if (!status) {
            shouldForgetJob = true;
            setError(
              'This image job is no longer available. Start a new image.',
            );
            return;
          }

          if (status.partialImageIds.length > 0) {
            setPartialGallery(
              galleryFromJob(status, status.partialImageIds, true),
            );
          }

          if (status.status === 'queued') {
            setGenerationStatus('queued', status.createdAt);
          } else if (status.status === 'running') {
            setGenerationStatus('generating', status.createdAt);
          } else if (status.status === 'completed') {
            setGenerationStatus('finalizing');
            applyCompletedJob(status);
            shouldForgetJob = true;
            return;
          } else if (status.status === 'cancelled') {
            shouldForgetJob = true;
            setPartialGallery([]);
            return;
          } else if (status.status === 'error') {
            setError(status.error ?? 'Image generation failed.');
            shouldForgetJob = true;
            return;
          }

          await delay(status.status === 'queued' ? 1000 : 2000);
          status = null;
        }
      } catch (e) {
        if (operationRef.current !== operation) return;
        console.error(e);
        setRecoverableJobId(jobId);
        setError(
          'Unable to refresh image progress. Your job is saved and will reconnect when you are online.',
        );
      } finally {
        if (operationRef.current === operation) {
          operationRef.current = null;
          setLoading(false);
          setGenerationStatus('idle', null);
          if (shouldForgetJob) {
            forgetActiveImageJob(jobId);
            setRecoverableJobId(null);
          }
        }
      }
    },
    [applyCompletedJob],
  );

  useEffect(() => {
    let cancelled = false;

    const resume = async () => {
      if (operationRef.current || stoppingRef.current) return;
      const jobs = await fetchActiveImageJobs().catch(() => []);
      const byId = new Map(jobs.map((job) => [job.jobId, job]));

      await Promise.all(
        rememberedImageJobIds().map(async (jobId) => {
          if (byId.has(jobId)) return;
          try {
            const job = await fetchImageJob(jobId);
            if (job) {
              byId.set(jobId, job);
            } else {
              forgetActiveImageJob(jobId);
            }
          } catch {
            // Preserve the saved id after a transient network failure so the
            // browser can resume it on the next online event or reload.
          }
        }),
      );

      if (cancelled || operationRef.current || stoppingRef.current) return;
      const latest = Array.from(byId.values()).sort(
        (a, b) => b.createdAt - a.createdAt,
      )[0];
      if (!latest) return;
      if (latest.status === 'error' || latest.status === 'cancelled') {
        forgetActiveImageJob(latest.jobId);
        return;
      }
      void pollImageJob(latest.jobId, latest);
    };

    void resume();
    const resumeWhenOnline = () => {
      void resume();
    };
    window.addEventListener('online', resumeWhenOnline);
    return () => {
      cancelled = true;
      operationRef.current = null;
      window.removeEventListener('online', resumeWhenOnline);
    };
  }, [pollImageJob]);

  const submit = useCallback(async () => {
    if (useImagePanelStore.getState().loading) return;
    if (recoverableJobId) {
      void pollImageJob(recoverableJobId);
      return;
    }

    const state = useImagePanelStore.getState();
    const {
      prompt,
      preserveList,
      guidance,
      params,
      inputImages,
      maskImage,
      model,
      setError,
      setLoading,
      setGenerationStatus,
      setPartialGallery,
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

    const operation: ImageOperation = {
      submissionId: uuidv4(),
      controller: new AbortController(),
      cancelRequested: false,
    };
    operationRef.current = operation;
    setError(null);
    setLoading(true);
    setPartialGallery([]);
    setGenerationStatus('queued', Date.now());
    try {
      const cleanedParams = cleanImageParamsForModel(params, model, mode);

      const body: Record<string, unknown> = {
        submissionId: operation.submissionId,
        mode,
        prompt,
        preserve: preserveList,
        guidance,
        model,
        ...cleanedParams,
      };
      if (mode === 'edit') {
        body.imageRefs = inputImages;
        if (maskImage) body.maskRef = maskImage;
      }

      setGenerationStatus('submitting');
      const jobId = await startImageJob(body, operation.controller?.signal);
      operation.jobId = jobId;
      if (operation.cancelRequested || operationRef.current !== operation)
        return;
      await pollImageJob(jobId, null, operation);
    } catch (e) {
      if (operationRef.current !== operation) return;
      console.error(e);
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        setLoading(false);
        setGenerationStatus('idle', null);
      }
    }
  }, [pollImageJob, recoverableJobId]);

  const stopGeneration = useCallback(async () => {
    const operation = operationRef.current;
    if (!operation || operation.cancelRequested) return;
    operation.cancelRequested = true;
    stoppingRef.current = true;
    // Detach the old poll before awaiting cancellation, so late responses
    // cannot publish output or clear the loading state of a later request.
    operationRef.current = null;
    const { setLoading, setGenerationStatus, setPartialGallery, setError } =
      useImagePanelStore.getState();
    setGenerationStatus('stopping');
    setError(null);
    try {
      const query = operation.submissionId
        ? `submissionId=${encodeURIComponent(operation.submissionId)}`
        : `jobId=${encodeURIComponent(operation.jobId!)}`;
      const response = await fetch(`/api/images/jobs?${query}`, {
        method: 'DELETE',
        credentials: 'include',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok)
        throw new Error('Could not stop image generation. Please try again.');
      const status = await response.json();
      if (
        !status.cancelled &&
        !['completed', 'error', 'cancelled'].includes(status.status)
      ) {
        throw new Error('Cancellation was not confirmed. Please try again.');
      }
      operation.controller?.abort();
      if (operation.jobId) forgetActiveImageJob(operation.jobId);
      setRecoverableJobId(null);
      setLoading(false);
      setGenerationStatus('idle', null);
      setPartialGallery([]);
    } catch {
      operation.cancelRequested = false;
      operationRef.current = operation;
      setGenerationStatus(operation.jobId ? 'generating' : 'submitting');
      if (operation.jobId) void pollImageJob(operation.jobId, null, operation);
      setError('Could not stop image generation. Please try Stop again.');
    } finally {
      stoppingRef.current = false;
    }
  }, [pollImageJob]);

  const reuseRef = useCallback(
    (ref: ImageRef) => reuseOutputAsInput(ref),
    [reuseOutputAsInput],
  );

  return (
    <div className="image-workspace relative flex h-full w-full flex-col overflow-hidden bg-app text-primary">
      <header className="z-10 flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-separator/70 px-3 pb-2 pt-2 safe-top md:border-0 md:px-5 md:py-3">
        <h1 className="min-w-fit flex-1 text-base font-semibold tracking-tight text-primary">
          <span className="md:hidden">Create</span>
          <span className="hidden md:inline">Create</span>
        </h1>
        <div className="order-3 min-w-0 w-full md:order-none md:w-auto">
          <ModeSegmentedControl fullWidth />
        </div>
        <div className="ml-auto flex justify-end md:flex-1">
          <HistoryToggleButton />
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
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
              onOpenSelectedImage={() => setOutputActionsOpen(true)}
              emptyState={
                <CreateEmptyState mode={mode} inputCount={inputCount} />
              }
            />
          </div>

          {error && (
            <div className="flex-none px-4 pb-1">
              <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-nvidia-red backdrop-blur">
                <span>{error}</span>
                {!loading && (
                  <button
                    type="button"
                    onClick={() => {
                      if (recoverableJobId) {
                        void pollImageJob(recoverableJobId);
                      } else {
                        void submit();
                      }
                    }}
                    className="shrink-0 rounded-md px-2 py-1 font-medium text-nvidia-red transition-colors hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50"
                  >
                    {recoverableJobId ? 'Check status' : 'Try again'}
                  </button>
                )}
              </div>
            </div>
          )}

          <ImagesDock onSubmit={submit} onStop={stopGeneration} />
        </div>

        <aside className="hidden w-[360px] flex-none flex-col border-l border-separator/70 bg-app/90 lg:flex">
          <div className="min-h-0 flex-1">
            <ImageSettingsPanel />
          </div>
          {isDesktop && (
            <OutputDetailPanel
              image={selectedImage}
              onReuseAsInput={reuseRef}
              onSendToChat={onSendToChat}
              onDelete={removeFromGallery}
            />
          )}
        </aside>
      </div>

      <HistoryDrawer />
      <OutputActionSheet
        open={outputActionsOpen && !isDesktop}
        image={selectedImage}
        onClose={() => setOutputActionsOpen(false)}
        onReuseAsInput={reuseRef}
        onSendToChat={onSendToChat}
        onDelete={removeFromGallery}
      />
    </div>
  );
}

function CreateEmptyState({
  mode,
  inputCount,
}: {
  mode: 'generate' | 'edit';
  inputCount: number;
}) {
  const editingWithInput = mode === 'edit' && inputCount > 0;
  const title =
    mode === 'generate'
      ? 'Start with an idea'
      : editingWithInput
      ? 'Your image is ready to edit'
      : 'Add an image to begin editing';
  const description =
    mode === 'generate'
      ? 'Describe the image you want, then tap Create.'
      : editingWithInput
      ? 'Describe the change in the prompt below, then tap Apply edit.'
      : 'Use Add image in the prompt bar, then describe the change you want.';
  return (
    <div className="w-full max-w-md space-y-3 p-4 text-center">
      <h2 className="text-2xl font-semibold tracking-tight text-primary">
        {title}
      </h2>
      <p className="mx-auto max-w-sm text-base leading-relaxed text-secondary">
        {description}
      </p>
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
      <div className="border-t border-separator/70 p-4 text-xs text-muted">
        Select an output to view its prompt, settings, and actions.
      </div>
    );
  }

  const ref = generatedRef(image);
  const fullUrl = getImageUrl(ref, false);

  return (
    <div className="max-h-[44vh] overflow-y-auto border-t border-separator/70 p-4">
      <div className="mb-3 text-sm font-medium text-primary">Output Detail</div>
      <div className="mb-3 overflow-hidden rounded-lg bg-panel ring-1 ring-separator/70">
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
        <ImageDownloadAction
          imageId={image.imageId}
          icon={<IconDownload size={14} />}
          className={outputActionClasses()}
        />
        <OutputAction
          icon={<IconExternalLink size={14} />}
          href={fullUrl}
          target="_blank"
        >
          Open
        </OutputAction>
        <OutputAction
          icon={<IconTrash size={14} />}
          danger
          onClick={() => onDelete(image.imageId)}
        >
          Remove from workspace
        </OutputAction>
      </div>
      <ImagePromptDetail image={image} />
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
  href,
  target,
  danger,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  target?: string;
  danger?: boolean;
}) {
  const className = outputActionClasses(danger);
  if (href) {
    return (
      <a
        href={href}
        target={target}
        rel={target === '_blank' ? 'noopener noreferrer' : undefined}
        className={className}
      >
        {icon}
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {icon}
      {children}
    </button>
  );
}

function outputActionClasses(danger = false) {
  return classNames(
    'inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs transition-colors',
    danger
      ? 'border-red-500/20 text-nvidia-red hover:bg-red-500/10'
      : 'border-separator/70 text-secondary hover:bg-fill/5 hover:text-primary',
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
      <div className="mb-1 text-[0.75rem] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="whitespace-pre-wrap break-words rounded-md bg-fill/5 p-2 text-[0.75rem] leading-relaxed text-secondary">
        {children}
      </div>
    </div>
  );
}
