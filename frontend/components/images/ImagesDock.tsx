'use client';

import React, { memo, useCallback, useEffect, useRef } from 'react';
import classNames from 'classnames';
import { IconArrowUp, IconPhotoUp } from '@tabler/icons-react';
import { useImagePanelStore, selectMode } from '@/state/imagePanelStore';
import { PresetsPopover, DockIconTrigger } from './PresetsPopover';
import { ParamsPopover } from './ParamsPopover';
import { AttachmentsPopover } from './AttachmentsPopover';

const N_CYCLE = [1, 2, 4, 8] as const;

interface ImagesDockProps {
  onSubmit: () => void;
}

/**
 * Bottom prompt bar. Flex-none so the canvas above it takes the rest.
 * Textarea auto-grows. Four icon popovers + submit live in a memoized
 * actions row so prompt keystrokes don't re-render the controls.
 */
export const ImagesDock = memo(function ImagesDock({ onSubmit }: ImagesDockProps) {
  const prompt = useImagePanelStore((s) => s.prompt);
  const setPrompt = useImagePanelStore((s) => s.setPrompt);
  const loading = useImagePanelStore((s) => s.loading);
  const n = useImagePanelStore((s) => s.params.n ?? 1);
  const setParam = useImagePanelStore((s) => s.setParam);
  const mode = useImagePanelStore(selectMode);

  const submitDisabled = loading || !prompt.trim();

  const cycleN = useCallback(() => {
    const idx = N_CYCLE.indexOf(n as (typeof N_CYCLE)[number]);
    const next = N_CYCLE[(idx + 1) % N_CYCLE.length];
    setParam('n', next === 1 ? undefined : next);
  }, [n, setParam]);

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
    <div className="flex-none px-2 md:px-4 pt-2 pb-safe-bottom">
      <div
        className={classNames(
          'w-full md:max-w-3xl md:mx-auto',
          'rounded-2xl backdrop-blur-xl',
          'bg-neutral-900/80 border border-white/10',
          'shadow-[0_20px_50px_-20px_rgba(0,0,0,0.6)]',
        )}
      >
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe what you want to see…"
          rows={1}
          disabled={loading}
          className={classNames(
            'w-full resize-none bg-transparent px-4 pt-3 pb-1',
            'text-sm text-neutral-100 placeholder:text-neutral-500',
            'focus:outline-none',
            'max-h-[30vh] overflow-y-auto',
          )}
        />

        <DockActionsRow
          loading={loading}
          n={n}
          mode={mode}
          onCycleN={cycleN}
          onSubmit={onSubmit}
          submitDisabled={submitDisabled}
        />
      </div>
    </div>
  );
});

interface DockActionsRowProps {
  loading: boolean;
  n: number;
  mode: 'generate' | 'edit';
  onCycleN: () => void;
  onSubmit: () => void;
  submitDisabled: boolean;
}

const DockActionsRow = memo(function DockActionsRow({
  loading,
  n,
  mode,
  onCycleN,
  onSubmit,
  submitDisabled,
}: DockActionsRowProps) {
  return (
    <div className="flex items-center justify-between px-2 pb-2">
      <div className="flex items-center gap-0.5">
        <PresetsPopover disabled={loading} />
        <ParamsPopover disabled={loading} />
        <NButton n={n} onClick={onCycleN} disabled={loading} />
        <AttachmentsPopover disabled={loading} />
      </div>

      <div className="flex items-center gap-2 pr-1">
        <ModeIndicator mode={mode} />
        <SubmitButton
          onClick={onSubmit}
          disabled={submitDisabled}
          loading={loading}
        />
      </div>
    </div>
  );
});

function NButton({
  n,
  onClick,
  disabled,
}: {
  n: number;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <DockIconTrigger
      onClick={onClick}
      disabled={disabled}
      aria-label={`${n} variation${n === 1 ? '' : 's'}`}
    >
      <span className="text-xs font-medium tabular-nums">{n}x</span>
    </DockIconTrigger>
  );
}

function ModeIndicator({ mode }: { mode: 'generate' | 'edit' }) {
  return (
    <span
      className={classNames(
        'text-[10px] uppercase tracking-wider font-medium px-2 py-0.5 rounded-full',
        mode === 'edit'
          ? 'bg-nvidia-green/10 text-nvidia-green'
          : 'bg-white/5 text-neutral-500',
      )}
    >
      {mode === 'edit' ? (
        <span className="inline-flex items-center gap-1">
          <IconPhotoUp size={10} />
          Edit
        </span>
      ) : (
        'Generate'
      )}
    </span>
  );
}

function SubmitButton({
  onClick,
  disabled,
  loading,
}: {
  onClick: () => void;
  disabled: boolean;
  loading: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Submit"
      className={classNames(
        'inline-flex items-center justify-center w-9 h-9 rounded-full',
        'transition-all',
        disabled
          ? 'bg-white/5 text-neutral-600 cursor-not-allowed'
          : 'bg-white text-black hover:bg-neutral-200 active:scale-95',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40',
      )}
    >
      {loading ? (
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
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
        <IconArrowUp size={18} strokeWidth={2.5} />
      )}
    </button>
  );
}
