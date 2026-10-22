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
    // The shared segmented control: a raised thumb on a tinted track, or a
    // glass group when the toolbar shows it.
    <div
      role="radiogroup"
      aria-label="Image creation mode"
      className={classNames('app-segmented', fullWidth && 'w-full md:w-auto')}
    >
      {MODES.map((item) => {
        const selected = mode === item.value;
        return (
          <label
            key={item.value}
            className="relative flex min-w-0 flex-1 cursor-pointer"
          >
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
                'app-segment w-full px-4 text-sm',
                'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus',
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
