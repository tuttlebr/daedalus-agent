'use client';

import React, { forwardRef, memo } from 'react';
import classNames from 'classnames';

export type IconButtonVariant = 'default' | 'ghost' | 'solid' | 'accent' | 'outline' | 'danger';
export type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const variantClasses: Record<IconButtonVariant, string> = {
  default: `
    bg-neutral-100/80 dark:bg-neutral-800/60
    text-neutral-600 dark:text-neutral-400
    hover:bg-neutral-200 dark:hover:bg-neutral-700
    hover:text-neutral-900 dark:hover:text-neutral-100
    active:scale-95
    focus-visible:ring-2 focus-visible:ring-neutral-400/40
  `,
  ghost: `
    bg-transparent
    text-neutral-500 dark:text-neutral-400
    hover:bg-neutral-100 dark:hover:bg-neutral-800
    hover:text-neutral-900 dark:hover:text-neutral-100
    active:scale-95
    focus-visible:ring-2 focus-visible:ring-neutral-400/40
  `,
  solid: `
    bg-black dark:bg-white text-white dark:text-black
    hover:bg-neutral-800 dark:hover:bg-neutral-200
    active:scale-95
    focus-visible:ring-2 focus-visible:ring-neutral-400/40
  `,
  accent: `
    bg-nvidia-green text-white
    hover:bg-nvidia-green-dark hover:shadow-[0_0_20px_rgba(118,185,0,0.4)]
    active:scale-95
    focus-visible:ring-2 focus-visible:ring-nvidia-green/40
  `,
  outline: `
    bg-transparent
    border border-neutral-300 dark:border-neutral-600
    text-neutral-600 dark:text-neutral-400
    hover:bg-neutral-100 dark:hover:bg-neutral-800
    hover:border-neutral-400 dark:hover:border-neutral-500
    active:scale-95
    focus-visible:ring-2 focus-visible:ring-neutral-400/40
  `,
  danger: `
    bg-transparent text-neutral-500 dark:text-neutral-400
    hover:bg-red-100 dark:hover:bg-red-900/30
    hover:text-red-600 dark:hover:text-red-400
    active:scale-95
    focus-visible:ring-2 focus-visible:ring-red-500/40
  `,
};

const sizeClasses: Record<IconButtonSize, { button: string; icon: number }> = {
  xs: { button: 'w-8 h-8 rounded-md', icon: 14 },
  sm: { button: 'w-10 h-10 rounded-lg', icon: 16 },
  md: { button: 'w-11 h-11 rounded-lg', icon: 20 },
  lg: { button: 'w-12 h-12 rounded-xl', icon: 24 },
};

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: React.ReactElement;
  'aria-label': string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  isLoading?: boolean;
  tooltip?: string;
}

export const IconButton = memo(forwardRef<HTMLButtonElement, IconButtonProps>(({
  icon,
  'aria-label': ariaLabel,
  variant = 'default',
  size = 'md',
  isLoading = false,
  tooltip,
  disabled,
  className = '',
  ...props
}, ref) => {
  const isDisabled = disabled || isLoading;
  const sizeConfig = sizeClasses[size];

  const sizedIcon = React.cloneElement(icon, {
    size: sizeConfig.icon,
    className: classNames(icon.props.className, 'flex-shrink-0'),
  });

  return (
    <button
      ref={ref}
      type="button"
      disabled={isDisabled}
      aria-label={ariaLabel}
      title={tooltip || ariaLabel}
      className={classNames(
        'inline-flex items-center justify-center',
        'transition-all duration-200 ease-out',
        'focus-visible:outline-none',
        'select-none cursor-pointer touch-manipulation',
        sizeConfig.button,
        variantClasses[variant],
        isDisabled && 'opacity-50 cursor-not-allowed pointer-events-none',
        className
      )}
      {...props}
    >
      {isLoading ? (
        <svg className="animate-spin flex-shrink-0" style={{ width: sizeConfig.icon, height: sizeConfig.icon }} fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      ) : sizedIcon}
    </button>
  );
}));

IconButton.displayName = 'IconButton';
