'use client';

import React, { memo } from 'react';

import { useImagePanelStore, type ImageMode } from '@/state/imagePanelStore';
import classNames from 'classnames';

const MODES: Array<{
  value: ImageMode;
  label: string;
}> = [
  { value: 'generate', label: 'Generate' },
  { value: 'edit', label: 'Edit' },
];

export const ModeSegmentedControl = memo(function ModeSegmentedControl({
  fullWidth = false,
}: {
  fullWidth?: boolean;
}) {
  const mode = useImagePanelStore((s) => s.mode);
  const setMode = useImagePanelStore((s) => s.setMode);
  const loading = useImagePanelStore((s) => s.loading);

  return (
    <div
      role="radiogroup"
      aria-label="Image creation mode"
      className={classNames(
        'inline-grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] rounded-full bg-fill/[0.08] p-[2px]',
        fullWidth && 'w-full md:w-auto',
      )}
    >
      {MODES.map((item) => {
        const selected = mode === item.value;
        return (
          <label key={item.value} className="relative min-w-0 cursor-pointer">
            <input
              type="radio"
              name="image-creation-mode"
              value={item.value}
              checked={selected}
              disabled={loading}
              onChange={() => setMode(item.value)}
              className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
            />
            <span
              className={classNames(
                'flex min-h-11 flex-wrap items-center justify-center gap-2 rounded-full px-[8px] py-2 text-sm text-secondary transition-colors md:min-h-9',
                'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus',
                // The selected segment is raised above the track, as in a platform
                // segmented control.
                selected && 'bg-elevated font-semibold text-primary shadow',
                loading && 'cursor-not-allowed opacity-50',
              )}
            >
              {item.label}
            </span>
          </label>
        );
      })}
    </div>
  );
});
