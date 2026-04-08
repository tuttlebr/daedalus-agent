'use client';

import React, { memo, useEffect, useCallback, useRef } from 'react';
import classNames from 'classnames';
import { IconX } from '@tabler/icons-react';
import { IconButton } from './IconButton';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  showClose?: boolean;
  className?: string;
}

const sizeClasses: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)]',
};

export const Dialog = memo(({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
  showClose = true,
  className = '',
}: DialogProps) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Trap focus and handle Escape
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;

    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable?.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    // Focus first focusable element
    const timer = setTimeout(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      first?.focus();
    }, 100);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      clearTimeout(timer);
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-3xl backdrop-saturate-180 animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={dialogRef}
        className={classNames(
          'relative w-full animate-scale-in',
          'bg-dark-bg-secondary/95 backdrop-blur-2xl',
          'border border-white/10 rounded-2xl shadow-2xl',
          'overflow-hidden',
          sizeClasses[size],
          className
        )}
      >
        {/* Header */}
        {(title || showClose) && (
          <div className="flex items-center justify-between px-6 pt-5 pb-0">
            <div>
              {title && <h2 className="text-lg font-semibold text-dark-text-primary">{title}</h2>}
              {description && <p className="mt-1 text-sm text-dark-text-muted">{description}</p>}
            </div>
            {showClose && (
              <IconButton
                icon={<IconX />}
                aria-label="Close dialog"
                variant="ghost"
                size="sm"
                onClick={onClose}
              />
            )}
          </div>
        )}

        {/* Body */}
        <div className="px-6 py-5 overflow-y-auto max-h-[calc(100vh-12rem)]">
          {children}
        </div>
      </div>
    </div>
  );
});

Dialog.displayName = 'Dialog';
