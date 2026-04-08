'use client';

import React, { forwardRef, memo, useCallback, useEffect, useRef } from 'react';
import classNames from 'classnames';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
  maxRows?: number;
  autoResize?: boolean;
}

export const Textarea = memo(forwardRef<HTMLTextAreaElement, TextareaProps>(({
  error = false,
  maxRows = 6,
  autoResize = true,
  className = '',
  disabled,
  onChange,
  ...props
}, ref) => {
  const internalRef = useRef<HTMLTextAreaElement | null>(null);

  const setRef = useCallback((node: HTMLTextAreaElement | null) => {
    internalRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
  }, [ref]);

  const resize = useCallback(() => {
    const el = internalRef.current;
    if (!el || !autoResize) return;
    el.style.height = 'auto';
    const lineHeight = parseInt(getComputedStyle(el).lineHeight) || 20;
    const maxHeight = lineHeight * maxRows + 16; // padding
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [autoResize, maxRows]);

  useEffect(() => { resize(); }, [resize, props.value]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    resize();
    onChange?.(e);
  }, [onChange, resize]);

  return (
    <textarea
      ref={setRef}
      disabled={disabled}
      onChange={handleChange}
      className={classNames(
        'w-full font-sans resize-none',
        'bg-dark-bg-tertiary text-dark-text-primary placeholder:text-dark-text-muted',
        'border rounded-xl px-4 py-3 text-sm',
        'transition-colors duration-200',
        'focus:outline-none focus:ring-2 focus:ring-offset-0',
        'touch-manipulation',
        error
          ? 'border-nvidia-red/50 focus:ring-nvidia-red/30 focus:border-nvidia-red'
          : 'border-white/10 focus:ring-nvidia-green/30 focus:border-nvidia-green/50',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
      rows={1}
      {...props}
    />
  );
}));

Textarea.displayName = 'Textarea';
