'use client';

import React, { memo, useState, useRef, useCallback } from 'react';
import classNames from 'classnames';

export interface TooltipProps {
  content: string;
  children: React.ReactElement;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  className?: string;
}

export const Tooltip = memo(({
  content,
  children,
  position = 'top',
  delay = 300,
  className = '',
}: TooltipProps) => {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const show = useCallback(() => {
    timerRef.current = setTimeout(() => setVisible(true), delay);
  }, [delay]);

  const hide = useCallback(() => {
    clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  const positionClasses: Record<string, string> = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  return (
    <div className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {visible && content && (
        <div
          role="tooltip"
          className={classNames(
            'absolute z-50 pointer-events-none',
            'px-2.5 py-1.5 text-xs font-medium',
            'bg-dark-bg-quaternary text-dark-text-primary',
            'border border-white/10 rounded-lg shadow-lg',
            'whitespace-nowrap animate-fade-in',
            positionClasses[position],
            className
          )}
        >
          {content}
        </div>
      )}
    </div>
  );
});

Tooltip.displayName = 'Tooltip';
