'use client';

import React, { forwardRef, memo } from 'react';
import classNames from 'classnames';

export type InputSize = 'sm' | 'md' | 'lg';

const sizeClasses: Record<InputSize, string> = {
  sm: 'h-9 px-3 text-sm rounded-lg',
  md: 'h-11 px-3.5 text-sm rounded-lg',
  lg: 'h-14 px-4 text-base rounded-xl',
};

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: InputSize;
  error?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  wrapperClassName?: string;
}

export const Input = memo(forwardRef<HTMLInputElement, InputProps>(({
  size = 'md',
  error = false,
  leftIcon,
  rightIcon,
  wrapperClassName = '',
  className = '',
  disabled,
  ...props
}, ref) => (
  <div className={classNames('relative flex items-center', wrapperClassName)}>
    {leftIcon && (
      <span className="absolute left-3 flex items-center text-neutral-400 dark:text-neutral-500 pointer-events-none">
        {leftIcon}
      </span>
    )}
    <input
      ref={ref}
      disabled={disabled}
      className={classNames(
        'w-full font-sans',
        'bg-dark-bg-tertiary text-dark-text-primary placeholder:text-dark-text-muted',
        'border transition-colors duration-200',
        'focus:outline-none focus:ring-2 focus:ring-offset-0',
        'touch-manipulation',
        error
          ? 'border-nvidia-red/50 focus:ring-nvidia-red/30 focus:border-nvidia-red'
          : 'border-white/10 focus:ring-nvidia-green/30 focus:border-nvidia-green/50',
        sizeClasses[size],
        leftIcon && 'pl-10',
        rightIcon && 'pr-10',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
      {...props}
    />
    {rightIcon && (
      <span className="absolute right-3 flex items-center text-neutral-400 dark:text-neutral-500">
        {rightIcon}
      </span>
    )}
  </div>
)));

Input.displayName = 'Input';
