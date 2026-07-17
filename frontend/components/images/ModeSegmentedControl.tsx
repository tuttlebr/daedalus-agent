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
        'inline-grid grid-cols-2 rounded-lg border border-white/10 bg-black/25 p-0.5',
        fullWidth && 'w-full md:w-auto',
      )}
    >
      {MODES.map((item) => {
        const selected = mode === item.value;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={loading}
            onClick={() => setMode(item.value)}
            className={classNames(
              'inline-flex h-11 min-w-[96px] items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors md:h-8',
              fullWidth && 'min-w-0 w-full',
              selected
                ? 'bg-white text-black'
                : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-100',
              loading && 'cursor-not-allowed opacity-50',
            )}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
});
