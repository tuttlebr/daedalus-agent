'use client';

import { IconArrowUp, IconSquare } from '@tabler/icons-react';
import React, { memo, useEffect, useRef } from 'react';

import { OptimizedImage } from '@/components/chat/OptimizedImage';

import { AdjustPopover } from './AdjustPopover';
import { AttachmentsPopover } from './AttachmentsPopover';
import { ParamsPopover } from './ParamsPopover';
import { PresetsPopover } from './PresetsPopover';

import { useImagePanelStore, selectMode } from '@/state/imagePanelStore';
import classNames from 'classnames';

interface ImagesDockProps {
  onSubmit: () => void;
  /** Stop waiting on the in-flight generation and unlock the panel */
  onStop?: () => void;
}

/**
 * Bottom prompt bar. Flex-none so the canvas above it takes the rest.
 * Textarea auto-grows. The actions row is memoized so prompt keystrokes
 * don't re-render the controls.
 */
export const ImagesDock = memo(function ImagesDock({
  onSubmit,
  onStop,
}: ImagesDockProps) {
  const prompt = useImagePanelStore((s) => s.prompt);
  const setPrompt = useImagePanelStore((s) => s.setPrompt);
  const loading = useImagePanelStore((s) => s.loading);
  const guidance = useImagePanelStore((s) => s.guidance);
  const setGuidance = useImagePanelStore((s) => s.setGuidance);
  const mode = useImagePanelStore(selectMode);
  const inputCount = useImagePanelStore((s) => s.inputImages.length);

  const submitDisabled =
    loading || !prompt.trim() || (mode === 'edit' && inputCount === 0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = Math.round(window.innerHeight * 0.3);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [prompt]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!submitDisabled) onSubmit();
    }
  };

  return (
    <div
      data-chat-input
      className="relative z-20 flex-none max-h-full overflow-y-auto px-2 pb-2 pt-2 md:overflow-visible md:px-4 md:pb-safe-bottom"
    >
      <div
        className={classNames(
          'image-composer w-full md:max-w-3xl md:mx-auto',
          'rounded-2xl backdrop-blur-xl',
          'bg-panel/80 border border-separator/70',
          'shadow-[0_20px_50px_-20px_rgba(0,0,0,0.6)]',
        )}
      >
        {mode === 'edit' && <MobileEditAssetsRow disabled={loading} />}

        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            mode === 'edit'
              ? 'Describe the edit to apply to Image 1…'
              : 'Describe what you want to see…'
          }
          aria-label={
            mode === 'edit'
              ? 'Describe the edit to apply'
              : 'Describe an image to create'
          }
          rows={1}
          disabled={loading}
          className={classNames(
            'w-full resize-none bg-transparent px-4 pt-3 pb-1',
            'text-base text-primary placeholder:text-muted md:text-sm',
            'focus:outline-none',
            'min-h-[calc(1lh+1rem)] max-h-[30dvh] overflow-y-auto',
          )}
        />

        <label className="flex items-center gap-2 px-4 py-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={guidance === 'exact'}
            disabled={loading}
            onChange={(event) =>
              setGuidance(event.target.checked ? 'exact' : 'auto')
            }
          />
          Use my prompt exactly
        </label>

        <DockActionsRow
          loading={loading}
          mode={mode}
          onSubmit={onSubmit}
          onStop={onStop}
          submitDisabled={submitDisabled}
        />
      </div>
    </div>
  );
});

interface DockActionsRowProps {
  loading: boolean;
  mode: 'generate' | 'edit';
  onSubmit: () => void;
  onStop?: () => void;
  submitDisabled: boolean;
}

const DockActionsRow = memo(function DockActionsRow({
  loading,
  mode,
  onSubmit,
  onStop,
  submitDisabled,
}: DockActionsRowProps) {
  return (
    <div
      data-create-actions
      className="flex flex-wrap items-center justify-between gap-1 px-1 pb-2 md:gap-2 md:px-2"
    >
      <div className="flex shrink-0 items-center gap-0.5">
        <div className="md:hidden">
          <AdjustPopover disabled={loading} />
        </div>
        <div className="hidden items-center gap-0.5 md:flex">
          <PresetsPopover disabled={loading} />
          <ParamsPopover disabled={loading} triggerClassName="lg:hidden" />
        </div>
      </div>

      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
        <SettingsSummary />
        {loading && onStop ? (
          <StopButton onClick={onStop} />
        ) : (
          <SubmitButton
            onClick={onSubmit}
            disabled={submitDisabled}
            loading={loading}
            mode={mode}
          />
        )}
      </div>
    </div>
  );
});

function MobileEditAssetsRow({ disabled }: { disabled: boolean }) {
  const inputImages = useImagePanelStore((state) => state.inputImages);
  const visibleImages = inputImages.slice(0, 3);
  const remaining = Math.max(0, inputImages.length - visibleImages.length);

  return (
    <div
      data-mobile-edit-assets
      className="flex min-h-14 items-center gap-2 border-b border-separator/70 px-2 py-1.5 md:hidden"
    >
      <AttachmentsPopover disabled={disabled} showLabel />
      {visibleImages.length > 0 ? (
        <div
          className="flex min-w-0 items-center gap-1.5"
          aria-label={`${inputImages.length} edit image${
            inputImages.length === 1 ? '' : 's'
          } attached`}
        >
          {visibleImages.map((image, index) => (
            <div
              key={image.imageId}
              className="h-9 w-9 flex-none overflow-hidden rounded-lg bg-panel ring-1 ring-separator/70"
            >
              <OptimizedImage
                imageRef={image}
                alt={`Edit image ${index + 1}`}
                useThumbnail
                showControls={false}
                enableFullscreen={false}
                className="h-full w-full object-cover"
              />
            </div>
          ))}
          {remaining > 0 && (
            <span className="grid h-9 min-w-9 place-items-center rounded-lg bg-fill/5 px-1 text-xs font-medium text-muted">
              +{remaining}
            </span>
          )}
        </div>
      ) : (
        <span className="min-w-0 truncate text-xs text-muted">
          Required before applying an edit
        </span>
      )}
    </div>
  );
}

function SettingsSummary() {
  const params = useImagePanelStore((s) => s.params);
  const parts = [
    `${params.n ?? 1} image${(params.n ?? 1) === 1 ? '' : 's'}`,
    params.size ?? 'auto',
    params.quality ?? 'auto',
  ];
  const compactParts = [`${params.n ?? 1}x`, params.size ?? 'auto'];

  return (
    <>
      {/* Condensed summary on phones so users can confirm settings at a glance */}
      <span className="settings-summary inline-flex rounded-full bg-fill/5 px-2 py-0.5 text-xs font-medium uppercase tracking-wider text-muted sm:hidden">
        {compactParts.join(' · ')}
      </span>
      <span className="settings-summary hidden rounded-full bg-fill/5 px-2 py-0.5 text-[0.75rem] font-medium uppercase tracking-wider text-muted sm:inline-flex">
        {parts.join(' · ')}
      </span>
    </>
  );
}

function StopButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Stop waiting for this generation"
      title="Stop waiting (the panel unlocks; the job keeps running server-side)"
      className={classNames(
        'inline-flex h-11 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold touch-manipulation',
        'bg-nvidia-red/15 text-nvidia-red border border-nvidia-red/30',
        'transition-all hover:bg-nvidia-red/25 active:scale-95',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-red/40',
      )}
    >
      <IconSquare size={16} strokeWidth={2.5} />
      <span>Stop</span>
    </button>
  );
}

function SubmitButton({
  onClick,
  disabled,
  loading,
  mode,
}: {
  onClick: () => void;
  disabled: boolean;
  loading: boolean;
  mode: 'generate' | 'edit';
}) {
  const label = mode === 'edit' ? 'Apply edit' : 'Create';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={classNames(
        'inline-flex h-11 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold touch-manipulation',
        'transition-all',
        disabled
          ? 'bg-fill/5 text-muted cursor-not-allowed'
          : 'bg-action text-on-action hover:brightness-95',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40',
      )}
    >
      {loading ? (
        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
          <circle
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="3"
            opacity="0.25"
          />
          <path
            d="M4 12a8 8 0 018-8"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <>
          <IconArrowUp size={18} strokeWidth={2.5} />
          <span>{label}</span>
        </>
      )}
    </button>
  );
}
