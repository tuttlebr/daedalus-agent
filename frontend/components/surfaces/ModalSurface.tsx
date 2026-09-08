'use client';

import React, { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useAppVisualViewport } from '@/hooks/useVisualViewportKeyboard';

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

/** Native modal semantics provide focus containment, inert background, and
 * correct stacking for nested sheets, including keyboard and screen readers. */
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
    const dialogRef = useRef<HTMLDialogElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const visualViewport = useAppVisualViewport();
    useEffect(() => setMounted(true), []);

    useEffect(() => {
      const dialog = dialogRef.current;
      if (!mounted || !open || !dialog) return;
      const previousFocus = document.activeElement as HTMLElement | null;
      if (activeModalCount++ === 0) {
        savedBodyOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
      }
      dialog.showModal();
      // Focus the sheet itself to announce its title without opening a phone's
      // keyboard. Tab then moves into its controls in document order.
      panelRef.current?.focus({ preventScroll: true });
      return () => {
        dialog.close();
        if (--activeModalCount === 0)
          document.body.style.overflow = savedBodyOverflow;
        if (previousFocus?.isConnected)
          previousFocus.focus({ preventScroll: true });
      };
    }, [mounted, open]);

    if (!mounted || !open) return null;
    const positions: Record<ModalSurfacePosition, string> = {
      left: 'items-stretch justify-start',
      right: 'items-stretch justify-end',
      center: 'app-dialog-centered items-center justify-center safe-y',
      bottom: 'items-end justify-center',
      fullscreen: 'items-stretch justify-stretch',
    };

    return createPortal(
      <dialog
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-keyboard-open={visualViewport.keyboardOpen ? 'true' : 'false'}
        className="app-dialog fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-hidden border-0 bg-transparent p-0"
        style={{ height: visualViewport.height ?? undefined }}
        onKeyDown={(event) => {
          if (
            event.key !== 'Tab' ||
            (event.target instanceof Element &&
              event.target.closest('dialog') !== event.currentTarget)
          )
            return;
          const dialog = event.currentTarget;
          const controls = Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
            ),
          ).filter(
            (el) =>
              el.getClientRects().length && !el.closest('[hidden], [inert]'),
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (!first) {
            event.preventDefault();
            return;
          }
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === panelRef.current)
          ) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        onCancel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
      >
        <div
          className={classNames(
            'app-safe-x relative flex h-full w-full',
            positions[position],
          )}
        >
          <div
            className={classNames('absolute inset-0', backdropClassName)}
            onPointerDown={onClose}
            aria-hidden="true"
          />
          <div
            ref={panelRef}
            tabIndex={-1}
            className={classNames(
              'app-dialog-panel relative z-10 outline-none animate-fade-in motion-reduce:animate-none',
              className,
            )}
          >
            {children}
          </div>
        </div>
      </dialog>,
      document.body,
    );
  },
);

ModalSurface.displayName = 'ModalSurface';
