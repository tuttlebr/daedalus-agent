'use client';

import React, { memo, useEffect } from 'react';

import { useFocusTrap } from '@/hooks/useFocusTrap';

import classNames from 'classnames';

export interface GlassOverlayProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  position?: 'left' | 'right' | 'center' | 'bottom';
  className?: string;
  /** Accessible name for the dialog announced by screen readers */
  'aria-label'?: string;
}

/**
 * Full-screen overlay with glass backdrop.
 * Used for mobile sidebar, modals, and sheets.
 */
export const GlassOverlay = memo(
  ({
    open,
    onClose,
    children,
    position = 'center',
    className = '',
    'aria-label': ariaLabel,
  }: GlassOverlayProps) => {
    // Trap Tab focus inside the overlay, close on Escape, and restore focus
    // to the trigger on close. autoFocus is off so opening the overlay never
    // pops the mobile keyboard when the first focusable element is an input;
    // the panel container receives focus instead.
    const { containerRef } = useFocusTrap({
      isActive: open,
      onEscape: onClose,
      autoFocus: false,
      restoreFocus: true,
    });

    useEffect(() => {
      if (!open) return;
      document.body.style.overflow = 'hidden';
      const focusTimer = window.setTimeout(() => {
        containerRef.current?.focus();
      }, 0);
      return () => {
        window.clearTimeout(focusTimer);
        document.body.style.overflow = '';
      };
    }, [open, containerRef]);

    if (!open) return null;

    const contentPosition: Record<string, string> = {
      left: 'items-stretch justify-start',
      right: 'items-stretch justify-end',
      center: 'items-center justify-center p-4',
      bottom: 'items-end justify-center',
    };

    const panelAnimation: Record<string, string> = {
      left: 'animate-slide-panel-in',
      right: 'animate-slide-panel-in',
      center: 'animate-scale-in',
      bottom: 'animate-slide-up',
    };

    return (
      <div
        className={classNames(
          'fixed inset-0 z-50 flex',
          contentPosition[position],
        )}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/60 backdrop-blur-xl animate-fade-in"
          onClick={onClose}
          aria-hidden="true"
        />

        {/* Content */}
        <div
          ref={containerRef}
          tabIndex={-1}
          className={classNames(
            'relative z-10 outline-none',
            panelAnimation[position],
            className,
          )}
        >
          {children}
        </div>
      </div>
    );
  },
);

GlassOverlay.displayName = 'GlassOverlay';
