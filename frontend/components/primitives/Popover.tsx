'use client';

import React, { memo, useState, useRef, useEffect, useCallback } from 'react';

import { useIsMobile } from '@/hooks/useMediaQuery';

import { ModalSurface } from '@/components/surfaces/ModalSurface';

import classNames from 'classnames';

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
  /** Visible and accessible name for the mobile sheet or desktop panel. */
  title?: string;
}

export const Popover = memo(
  ({
    trigger,
    children,
    position = 'bottom',
    align = 'center',
    className = '',
    sheetOnMobile = false,
    title,
  }: PopoverProps) => {
    const [open, setOpen] = useState(false);
    const [mounted, setMounted] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const isMobile = useIsMobile();
    const useSheet = sheetOnMobile && isMobile;
    const accessibleLabel =
      title ||
      (typeof trigger.props['aria-label'] === 'string'
        ? trigger.props['aria-label']
        : 'Options');

    const toggle = useCallback(() => setOpen((prev) => !prev), []);
    const close = useCallback(() => setOpen(false), []);

    useEffect(() => {
      setMounted(true);
    }, []);

    useEffect(() => {
      if (!open || useSheet) return;
      const handler = (e: PointerEvent) => {
        if (
          containerRef.current &&
          !containerRef.current.contains(e.target as Node)
        ) {
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
      if (rect.right > viewportWidth - edge)
        dx = viewportWidth - edge - rect.right;
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
      onClick: (event: React.MouseEvent) => {
        trigger.props.onClick?.(event);
        if (!event.defaultPrevented) toggle();
      },
      'aria-expanded': open,
      'aria-haspopup': 'dialog',
    });

    if (useSheet && mounted) {
      return (
        <>
          <div ref={containerRef} className="relative inline-flex">
            {triggerEl}
          </div>
          <ModalSurface
            open={open}
            onClose={close}
            position="bottom"
            aria-label={accessibleLabel}
            className={classNames(
              'flex max-h-[85vh] w-full flex-col overflow-hidden',
              'rounded-t-2xl bg-neutral-900/95 backdrop-blur-xl',
              'border-t border-white/10',
              className,
            )}
          >
            <div className="flex-none border-b border-white/[0.06] px-4 pb-2 pt-2">
              <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/15" />
              <div className="flex min-h-11 items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-neutral-100">
                  {accessibleLabel}
                </h2>
                <button
                  type="button"
                  onClick={close}
                  className="min-h-11 rounded-lg px-3 text-sm font-medium text-nvidia-green transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40"
                >
                  Done
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-safe-bottom">
              {children}
            </div>
          </ModalSurface>
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
            aria-label={accessibleLabel}
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
  },
);

Popover.displayName = 'Popover';
