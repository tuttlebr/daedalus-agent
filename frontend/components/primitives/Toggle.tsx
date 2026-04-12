'use client';

import React, { memo } from 'react';
import classNames from 'classnames';

export interface ToggleOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

export interface ToggleProps {
  options: [ToggleOption, ToggleOption];
  value: string;
  onChange: (value: string) => void;
  accentColors?: [string, string];
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Two-option pill toggle.
 * accentColors maps to each option's active color.
 */
export const Toggle = memo(({
  options,
  value,
  onChange,
  accentColors = ['bg-nvidia-green', 'bg-nvidia-purple'],
  size = 'md',
  className = '',
}: ToggleProps) => {
  const activeIndex = options.findIndex(o => o.value === value);

  return (
    <div
      className={classNames(
        'inline-flex rounded-xl p-1',
        'bg-dark-bg-tertiary border border-white/5',
        size === 'sm' ? 'gap-0.5' : 'gap-1',
        className
      )}
      role="radiogroup"
    >
      {options.map((option, i) => {
        const isActive = i === activeIndex;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(option.value)}
            className={classNames(
              'inline-flex items-center justify-center gap-1.5 font-medium rounded-lg',
              'transition-all duration-200 ease-out select-none touch-manipulation',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40',
              size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm',
              isActive
                ? `${accentColors[i]} text-white shadow-md`
                : 'text-dark-text-muted hover:text-dark-text-secondary'
            )}
          >
            {option.icon && <span className="flex-shrink-0">{option.icon}</span>}
            <span className="hidden sm:inline">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
});

Toggle.displayName = 'Toggle';
