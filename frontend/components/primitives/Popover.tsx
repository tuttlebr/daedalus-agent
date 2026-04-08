'use client';

import React, { memo, useState, useRef, useEffect, useCallback } from 'react';
import classNames from 'classnames';

export interface PopoverProps {
  trigger: React.ReactElement;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  className?: string;
}

export const Popover = memo(({
  trigger,
  children,
  position = 'bottom',
  align = 'center',
  className = '',
}: PopoverProps) => {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const toggle = useCallback(() => setOpen(prev => !prev), []);
  const close = useCallback(() => setOpen(false), []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, close]);

  const positionClasses: Record<string, string> = {
    top: 'bottom-full mb-2',
    bottom: 'top-full mt-2',
    left: 'right-full mr-2',
    right: 'left-full ml-2',
  };

  const alignClasses: Record<string, string> = {
    start: position === 'top' || position === 'bottom' ? 'left-0' : 'top-0',
    center: position === 'top' || position === 'bottom' ? 'left-1/2 -translate-x-1/2' : 'top-1/2 -translate-y-1/2',
    end: position === 'top' || position === 'bottom' ? 'right-0' : 'bottom-0',
  };

  return (
    <div ref={popoverRef} className="relative inline-flex">
      {React.cloneElement(trigger, { onClick: toggle })}
      {open && (
        <div
          className={classNames(
            'absolute z-50',
            'bg-dark-bg-secondary/95 backdrop-blur-xl',
            'border border-white/10 rounded-xl shadow-xl',
            'animate-scale-in min-w-[200px]',
            positionClasses[position],
            alignClasses[align],
            className
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
});

Popover.displayName = 'Popover';
