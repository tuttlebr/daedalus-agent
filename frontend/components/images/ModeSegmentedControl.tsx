'use client';

import { IconEdit, IconSparkles } from '@tabler/icons-react';
import React, { memo } from 'react';

import { useImagePanelStore, type ImageMode } from '@/state/imagePanelStore';
import classNames from 'classnames';

const MODES: Array<{
  value: ImageMode;
  label: string;
  icon: React.ReactNode;
}> = [
  { value: 'generate', label: 'Generate', icon: <IconSparkles size={14} /> },
  { value: 'edit', label: 'Edit', icon: <IconEdit size={14} /> },
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
        'inline-grid grid-cols-2 rounded-lg border border-separator/70 bg-fill/5 p-0.5',
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
                'flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm text-secondary transition-colors md:min-h-9',
                'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
                selected && 'bg-panel font-semibold text-primary shadow-sm',
                loading && 'cursor-not-allowed opacity-50',
              )}
            >
              {item.icon}
              {item.label}
            </span>
          </label>
        );
      })}
    </div>
  );
});
