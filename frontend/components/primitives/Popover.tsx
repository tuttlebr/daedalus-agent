'use client';

import React, {
  memo,
  useState,
  useRef,
  useEffect,
  useCallback,
} from 'react';
import { createPortal } from 'react-dom';
import classNames from 'classnames';
import { useIsMobile } from '@/hooks/useMediaQuery';

export interface PopoverProps {
  trigger: React.ReactElement;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  className?: string;
  /**
   * When true, renders as a bottom-sheet (via portal) on mobile viewports
   * instead of a floating panel. Desktop behavior is unchanged.
   */
  sheetOnMobile?: boolean;
}

export const Popover = memo(({
  trigger,
  children,
  position = 'bottom',
  align = 'center',
  className = '',
  sheetOnMobile = false,
}: PopoverProps) => {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const useSheet = sheetOnMobile && isMobile;

  const toggle = useCallback(() => setOpen((prev) => !prev), []);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open || useSheet) return;
    const handler = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open, close, useSheet]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, close]);

  // Desktop viewport-collision clamp for floating panel.
  // Uses marginLeft so we don't clobber Tailwind's -translate-x-1/2 centering.
  useEffect(() => {
    if (!open || useSheet) return;
    const el = panelRef.current;
    if (!el) return;
    el.style.marginLeft = '';
    const rect = el.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const edge = 8;
    let dx = 0;
    if (rect.right > viewportWidth - edge) dx = viewportWidth - edge - rect.right;
    if (rect.left + dx < edge) dx = edge - rect.left;
    if (dx !== 0) el.style.marginLeft = `${dx}px`;
  }, [open, useSheet, children]);

  const positionClasses: Record<string, string> = {
    top: 'bottom-full mb-2',
    bottom: 'top-full mt-2',
    left: 'right-full mr-2',
    right: 'left-full ml-2',
  };

  const alignClasses: Record<string, string> = {
    start: position === 'top' || position === 'bottom' ? 'left-0' : 'top-0',
    center:
      position === 'top' || position === 'bottom'
        ? 'left-1/2 -translate-x-1/2'
        : 'top-1/2 -translate-y-1/2',
    end: position === 'top' || position === 'bottom' ? 'right-0' : 'bottom-0',
  };

  const triggerEl = React.cloneElement(trigger, {
    onClick: toggle,
    'aria-expanded': open,
    'aria-haspopup': 'dialog',
  });

  if (useSheet && mounted) {
    return (
      <>
        <div ref={containerRef} className="relative inline-flex">
          {triggerEl}
        </div>
        {open &&
          createPortal(
            <>
              <div
                className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm animate-fade-in"
                onPointerDown={close}
                aria-hidden
              />
              <div
                role="dialog"
                aria-modal="true"
                className={classNames(
                  'fixed inset-x-0 bottom-0 z-[61]',
                  'rounded-t-2xl bg-neutral-900/95 backdrop-blur-xl',
                  'border-t border-white/10',
                  'max-h-[85vh] overflow-y-auto',
                  'pb-safe-bottom',
                  'animate-slide-up',
                  className,
                )}
              >
                <div className="mx-auto mt-2 mb-1 h-1 w-10 rounded-full bg-white/15" />
                {children}
              </div>
            </>,
            document.body,
          )}
      </>
    );
  }

  return (
    <div ref={containerRef} className="relative inline-flex">
      {triggerEl}
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          className={classNames(
            'absolute z-50',
            'bg-dark-bg-secondary/95 backdrop-blur-xl',
            'border border-white/10 rounded-xl shadow-xl',
            'animate-scale-in min-w-[200px]',
            positionClasses[position],
            alignClasses[align],
            className,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
});

Popover.displayName = 'Popover';
