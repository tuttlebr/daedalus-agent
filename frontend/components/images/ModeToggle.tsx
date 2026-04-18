'use client';

import React from 'react';
import classNames from 'classnames';
import type { ImageMode } from '@/state/imagePanelStore';

interface ModeToggleProps {
  mode: ImageMode;
  onChange: (mode: ImageMode) => void;
  disabled?: boolean;
}

const MODES: { id: ImageMode; label: string; description: string }[] = [
  { id: 'generate', label: 'Generate', description: 'From text only' },
  { id: 'edit', label: 'Edit', description: 'From one or more source images' },
];

export function ModeToggle({ mode, onChange, disabled }: ModeToggleProps) {
  return (
    <div
      role="tablist"
      className="inline-flex items-stretch rounded-xl bg-neutral-100 dark:bg-neutral-900 p-1 gap-1"
    >
      {MODES.map((m) => {
        const active = mode === m.id;
        return (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onChange(m.id)}
            className={classNames(
              'relative px-5 py-2 rounded-lg text-sm font-medium transition-all',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40',
              active
                ? 'bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 shadow-sm'
                : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            <div className="flex flex-col items-start gap-0.5">
              <span>{m.label}</span>
              <span className="text-[10px] font-normal opacity-70">
                {m.description}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
