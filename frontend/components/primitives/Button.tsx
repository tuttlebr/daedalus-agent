'use client';

import React, { forwardRef, memo } from 'react';

import classNames from 'classnames';

export type ButtonVariant =
  | 'primary'
  | 'accent'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'success'
  | 'outline';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const variantClasses: Record<ButtonVariant, string> = {
  primary: `
    bg-primary text-panel
    hover:opacity-90
    active:scale-[0.98]
    focus-visible:ring-2 focus-visible:ring-neutral-400/40 focus-visible:ring-offset-2 focus-visible:ring-offset-dark-bg-primary
  `,
  accent: `
    bg-action text-on-action
    hover:brightness-95
    active:scale-[0.98]
    focus-visible:ring-2 focus-visible:ring-nvidia-green/40 focus-visible:ring-offset-2 focus-visible:ring-offset-dark-bg-primary
  `,
  secondary: `
    bg-control text-primary
    hover:bg-control
    active:scale-[0.98]
    focus-visible:ring-2 focus-visible:ring-neutral-400/40
  `,
  ghost: `
    bg-transparent text-secondary
    hover:bg-control/10
    active:scale-[0.98]
    focus-visible:ring-2 focus-visible:ring-neutral-400/40
  `,
  danger: `
    bg-red-600 text-white
    hover:bg-red-700
    active:scale-[0.98]
    focus-visible:ring-2 focus-visible:ring-red-500/40
  `,
  success: `
    bg-emerald-600 text-white
    hover:bg-emerald-700
    active:scale-[0.98]
    focus-visible:ring-2 focus-visible:ring-emerald-500/40
  `,
  outline: `
    bg-transparent border-2 border-separator text-secondary
    hover:bg-panel dark:hover:bg-control hover:border-separator
    active:scale-[0.98]
    focus-visible:ring-2 focus-visible:ring-neutral-400/40
  `,
};

const sizeClasses: Record<ButtonSize, string> = {
  xs: 'px-2 py-1 text-xs rounded-md min-h-[28px]',
  sm: 'px-3 py-1.5 text-sm rounded-lg min-h-[32px]',
  md: 'px-4 py-2 text-sm rounded-lg min-h-[40px]',
  lg: 'px-5 py-2.5 text-base rounded-xl min-h-touch-min',
  xl: 'px-6 py-3 text-lg rounded-xl min-h-[52px]',
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
}

export const Button = memo(
  forwardRef<HTMLButtonElement, ButtonProps>(
    (
      {
        variant = 'primary',
        size = 'md',
        isLoading = false,
        leftIcon,
        rightIcon,
        fullWidth = false,
        disabled,
        className = '',
        children,
        ...props
      },
      ref,
    ) => {
      const isDisabled = disabled || isLoading;

      return (
        <button
          ref={ref}
          type="button"
          disabled={isDisabled}
          aria-busy={isLoading || undefined}
          className={classNames(
            'inline-flex items-center justify-center gap-2 font-medium',
            'transition-all duration-200 ease-out',
            'focus-visible:outline-none',
            'select-none cursor-pointer touch-manipulation',
            variantClasses[variant],
            sizeClasses[size],
            fullWidth && 'w-full',
            isDisabled && 'opacity-50 cursor-not-allowed pointer-events-none',
            className,
          )}
          {...props}
        >
          {isLoading && (
            <svg
              className="animate-spin h-4 w-4 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          )}
          {!isLoading && leftIcon && (
            <span className="flex-shrink-0">{leftIcon}</span>
          )}
          {children}
          {rightIcon && <span className="flex-shrink-0">{rightIcon}</span>}
        </button>
      );
    },
  ),
);

Button.displayName = 'Button';
