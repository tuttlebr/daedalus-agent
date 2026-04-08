'use client';

import React, { memo, useEffect, useCallback } from 'react';
import classNames from 'classnames';

export interface GlassOverlayProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  position?: 'left' | 'right' | 'center' | 'bottom';
  className?: string;
}

/**
 * Full-screen overlay with glass backdrop.
 * Used for mobile sidebar, modals, and sheets.
 */
export const GlassOverlay = memo(({
  open,
  onClose,
  children,
  position = 'center',
  className = '',
}: GlassOverlayProps) => {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [open, handleKeyDown]);

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
    <div className={classNames('fixed inset-0 z-50 flex', contentPosition[position])} role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-xl animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Content */}
      <div className={classNames('relative z-10', panelAnimation[position], className)}>
        {children}
      </div>
    </div>
  );
});

GlassOverlay.displayName = 'GlassOverlay';
