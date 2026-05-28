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
    } = applyPreset(preset, prompt, model);
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
      trigger={
        <DockIconTrigger disabled={disabled} aria-label="Presets">
          <IconGift size={16} />
        </DockIconTrigger>
      }
    >
      <div className="p-3 w-full md:w-72">
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
          Presets · {mode}
        </div>
        <div className="flex flex-col gap-1">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => handleApply(preset)}
              className="text-left px-3 py-2 rounded-lg hover:bg-white/5 transition-colors"
            >
              <div className="text-sm text-neutral-100">{preset.label}</div>
              <div className="text-[11px] text-neutral-500 mt-0.5 line-clamp-2">
                {preset.description}
              </div>
            </button>
          ))}
        </div>
      </div>
    </Popover>
  );
});

export const DockIconTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { disabled?: boolean }
>(function DockIconTrigger({ children, disabled, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={classNames(
        'inline-flex items-center justify-center w-11 h-11 rounded-full touch-manipulation',
        'text-neutral-400 hover:text-neutral-100 hover:bg-white/5',
        'transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40 md:w-8 md:h-8',
        disabled && 'opacity-40 cursor-not-allowed pointer-events-none',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
