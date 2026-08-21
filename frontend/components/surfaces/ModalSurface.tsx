'use client';

import React, { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useFocusTrap } from '@/hooks/useFocusTrap';

import classNames from 'classnames';

export type ModalSurfacePosition =
  | 'left'
  | 'right'
  | 'center'
  | 'bottom'
  | 'fullscreen';

export interface ModalSurfaceProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  'aria-label': string;
  position?: ModalSurfacePosition;
  className?: string;
  backdropClassName?: string;
}

let activeModalCount = 0;
let savedBodyOverflow = '';
let savedMainAriaHidden: string | null = null;

function isolateBackground(): () => void {
  const main = document.getElementById('main-content');
  if (activeModalCount === 0) {
    savedBodyOverflow = document.body.style.overflow;
    savedMainAriaHidden = main?.getAttribute('aria-hidden') ?? null;
    document.body.style.overflow = 'hidden';
    if (main) {
      main.inert = true;
      main.setAttribute('aria-hidden', 'true');
    }
  }
  activeModalCount += 1;

  return () => {
    activeModalCount = Math.max(0, activeModalCount - 1);
    if (activeModalCount !== 0) return;

    document.body.style.overflow = savedBodyOverflow;
    if (main) {
      main.inert = false;
      if (savedMainAriaHidden === null) main.removeAttribute('aria-hidden');
      else main.setAttribute('aria-hidden', savedMainAriaHidden);
    }
  };
}

/**
 * Portal-backed modal foundation used by sheets, drawers, and fullscreen
 * document views. It owns focus, Escape, background isolation, and body scroll.
 */
export const ModalSurface = memo(
  ({
    open,
    onClose,
    children,
    position = 'center',
    className = '',
    backdropClassName = '',
    'aria-label': ariaLabel,
  }: ModalSurfaceProps) => {
    const [mounted, setMounted] = useState(false);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const { containerRef } = useFocusTrap({
      isActive: open,
      onEscape: onClose,
      autoFocus: false,
      restoreFocus: false,
    });

    useEffect(() => setMounted(true), []);

    useEffect(() => {
      if (!open) return;
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      const restoreBackground = isolateBackground();
      const focusTimer = window.setTimeout(() => {
        containerRef.current?.focus();
      }, 0);

      return () => {
        window.clearTimeout(focusTimer);
        restoreBackground();
        previousFocusRef.current?.focus();
        previousFocusRef.current = null;
      };
    }, [containerRef, open]);

    if (!mounted || !open) return null;

    const contentPosition: Record<ModalSurfacePosition, string> = {
      left: 'items-stretch justify-start',
      right: 'items-stretch justify-end',
      center: 'items-center justify-center p-4',
      bottom: 'items-end justify-center',
      fullscreen: 'items-stretch justify-stretch',
    };

    const panelAnimation: Record<ModalSurfacePosition, string> = {
      left: 'animate-slide-panel-in',
      right: 'animate-slide-panel-in',
      center: 'animate-scale-in',
      bottom: 'animate-slide-up',
      fullscreen: 'animate-fade-in',
    };

    return createPortal(
      <div
        className={classNames(
          'fixed inset-0 z-[200] flex',
          contentPosition[position],
        )}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        <div
          className={classNames(
            'absolute inset-0 bg-black/60 backdrop-blur-xl animate-fade-in motion-reduce:animate-none',
            backdropClassName,
          )}
          onPointerDown={onClose}
          aria-hidden="true"
        />
        <div
          ref={containerRef}
          tabIndex={-1}
          className={classNames(
            'relative z-10 outline-none motion-reduce:animate-none',
            panelAnimation[position],
            className,
          )}
        >
          {children}
        </div>
      </div>,
      document.body,
    );
  },
);

ModalSurface.displayName = 'ModalSurface';
