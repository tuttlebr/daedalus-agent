'use client';

import React, { memo } from 'react';

import { ModalSurface } from './ModalSurface';

export interface GlassOverlayProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  position?: 'left' | 'right' | 'center' | 'bottom';
  className?: string;
  /** Accessible name for the dialog announced by screen readers */
  'aria-label': string;
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
    return (
      <ModalSurface
        open={open}
        onClose={onClose}
        position={position}
        aria-label={ariaLabel}
        className={className}
      >
        {children}
      </ModalSurface>
    );
  },
);

GlassOverlay.displayName = 'GlassOverlay';
