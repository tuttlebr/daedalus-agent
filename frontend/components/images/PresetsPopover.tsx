'use client';

import { IconGift } from '@tabler/icons-react';
import React, { memo } from 'react';

import {
  presetsForMode,
  applyPreset,
  type ImagePreset,
} from '@/utils/app/imagePresets';

import { Popover } from '@/components/primitives';

import {
  useImagePanelStore,
  selectMode,
  type ImageParams,
} from '@/state/imagePanelStore';
import classNames from 'classnames';

interface PresetsPopoverProps {
  disabled?: boolean;
}

export const PresetsPopover = memo(function PresetsPopover({
  disabled,
}: PresetsPopoverProps) {
  const mode = useImagePanelStore(selectMode);
  const model = useImagePanelStore((s) => s.model);

  const handleApply = (preset: ImagePreset) => {
    const { prompt, setPrompt, setPreserveList, setParam } =
      useImagePanelStore.getState();
    const {
      prompt: nextPrompt,
      preserveList: nextPreserve,
      params: nextParams,
    } = applyPreset(preset, prompt, model, mode);
    setPrompt(nextPrompt);
    if (nextPreserve !== undefined) setPreserveList(nextPreserve);
    (Object.keys(nextParams) as (keyof ImageParams)[]).forEach((k) => {
      setParam(k, nextParams[k] as never);
    });
  };

  const presets = presetsForMode(mode);

  return (
    <Popover
      position="top"
      align="start"
      sheetOnMobile
      title="Presets"
      trigger={
        <DockIconTrigger disabled={disabled} aria-label="Presets">
          <IconGift size={16} />
        </DockIconTrigger>
      }
    >
      <PresetsPanel mode={mode} presets={presets} onApply={handleApply} />
    </Popover>
  );
});

export function PresetsPanel({
  mode,
  presets,
  onApply,
  showHeading = true,
}: {
  mode: 'generate' | 'edit';
  presets: ImagePreset[];
  onApply: (preset: ImagePreset) => void;
  showHeading?: boolean;
}) {
  return (
    <div className="w-full p-3 md:w-72">
      {showHeading && (
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
          Presets · {mode}
        </div>
      )}
      <div className="flex flex-col gap-1">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => onApply(preset)}
            className="min-h-11 rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40"
          >
            <div className="text-sm text-neutral-100">{preset.label}</div>
            <div className="mt-0.5 line-clamp-2 text-xs text-neutral-500">
              {preset.description}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export const DockIconTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    disabled?: boolean;
    labeled?: boolean;
  }
>(function DockIconTrigger(
  { children, disabled, className, labeled = false, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={classNames(
        'inline-flex items-center justify-center touch-manipulation',
        labeled
          ? 'h-11 w-auto gap-2 rounded-xl px-3 text-xs font-medium md:h-8 md:w-8 md:rounded-full md:px-0'
          : 'h-11 w-11 rounded-full md:h-8 md:w-8',
        'text-neutral-400 hover:text-neutral-100 hover:bg-white/5',
        'transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40',
        disabled && 'opacity-40 cursor-not-allowed pointer-events-none',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
