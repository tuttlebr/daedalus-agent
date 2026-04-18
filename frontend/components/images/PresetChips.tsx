'use client';

import React from 'react';
import classNames from 'classnames';
import { Tooltip } from '@/components/primitives';
import type { ImageMode } from '@/state/imagePanelStore';
import { presetsForMode, type ImagePreset } from '@/utils/app/imagePresets';

interface PresetChipsProps {
  mode: ImageMode;
  onApply: (preset: ImagePreset) => void;
}

export function PresetChips({ mode, onApply }: PresetChipsProps) {
  const presets = presetsForMode(mode);
  if (presets.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        Presets
      </label>
      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => (
          <Tooltip key={preset.id} content={preset.description} position="bottom">
            <button
              type="button"
              onClick={() => onApply(preset)}
              className={classNames(
                'px-3 py-1.5 rounded-full text-xs font-medium transition-all',
                'bg-neutral-100 dark:bg-neutral-800',
                'text-neutral-700 dark:text-neutral-300',
                'hover:bg-nvidia-green/10 hover:text-nvidia-green hover:ring-1 hover:ring-nvidia-green/40',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40',
              )}
            >
              {preset.label}
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
