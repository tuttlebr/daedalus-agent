'use client';

import { IconArrowUp } from '@tabler/icons-react';
import React, { memo, useCallback, useEffect, useRef } from 'react';

import { AttachmentsPopover } from './AttachmentsPopover';
import { ParamsPopover } from './ParamsPopover';
import { PresetsPopover } from './PresetsPopover';

import { useImagePanelStore, selectMode } from '@/state/imagePanelStore';
import classNames from 'classnames';

interface ImagesDockProps {
  onSubmit: () => void;
}

/**
 * Bottom prompt bar. Flex-none so the canvas above it takes the rest.
 * Textarea auto-grows. The actions row is memoized so prompt keystrokes
 * don't re-render the controls.
 */
export const ImagesDock = memo(function ImagesDock({
  onSubmit,
}: ImagesDockProps) {
  const prompt = useImagePanelStore((s) => s.prompt);
  const setPrompt = useImagePanelStore((s) => s.setPrompt);
  const loading = useImagePanelStore((s) => s.loading);
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
    <div className="flex-none px-2 md:px-4 pt-2 pb-2 md:pb-safe-bottom">
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
          placeholder={
            mode === 'edit'
              ? 'Describe the edit to apply to Image 1…'
              : 'Describe what you want to see…'
          }
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
          mode={mode}
          onSubmit={onSubmit}
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
  submitDisabled: boolean;
}

const DockActionsRow = memo(function DockActionsRow({
  loading,
  mode,
  onSubmit,
  submitDisabled,
}: DockActionsRowProps) {
  return (
    <div className="flex items-center justify-between px-2 pb-2">
      <div className="flex items-center gap-0.5">
        <PresetsPopover disabled={loading} />
        <ParamsPopover disabled={loading} triggerClassName="lg:hidden" />
        {mode === 'edit' && (
          <AttachmentsPopover disabled={loading} triggerClassName="lg:hidden" />
        )}
      </div>

      <div className="flex items-center gap-2 pr-1">
        <SettingsSummary />
        <SubmitButton
          onClick={onSubmit}
          disabled={submitDisabled}
          loading={loading}
        />
      </div>
    </div>
  );
});

function SettingsSummary() {
  const model = useImagePanelStore((s) => s.model);
  const params = useImagePanelStore((s) => s.params);
  const mode = useImagePanelStore(selectMode);
  const parts = [
    model,
    mode,
    `${params.n ?? 1}x`,
    params.size ?? 'auto',
    params.quality ?? 'auto',
  ];

  return (
    <span
      className={classNames(
        'hidden rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500 sm:inline-flex',
      )}
    >
      {parts.join(' · ')}
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
        'inline-flex items-center justify-center w-11 h-11 rounded-full touch-manipulation',
        'transition-all',
        disabled
          ? 'bg-white/5 text-neutral-600 cursor-not-allowed'
          : 'bg-white text-black hover:bg-neutral-200 active:scale-95',
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
        <IconArrowUp size={20} strokeWidth={2.5} />
      )}
    </button>
  );
}
