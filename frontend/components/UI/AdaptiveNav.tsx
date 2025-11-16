import React from 'react';
import classNames from 'classnames';

import { GlassPanel } from './GlassPanel';

export interface AdaptiveNavItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  hint?: string;
  badge?: string | number;
  active?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

export interface AdaptiveNavProps
  extends React.HTMLAttributes<HTMLElement> {
  items: AdaptiveNavItem[];
  orientation?: 'horizontal' | 'vertical';
  condensed?: boolean;
  floating?: boolean;
}

export const AdaptiveNav: React.FC<AdaptiveNavProps> = ({
  items,
  orientation = 'horizontal',
  condensed = false,
  floating = false,
  className,
  ...rest
}) => {
  const isVertical = orientation === 'vertical';

  return (
    <GlassPanel
      as="nav"
      depth={floating ? 'floating' : 'raised'}
      glow={floating ? 'soft' : 'none'}
      className={classNames('lg-panel-spacing', className)}
      {...rest}
    >
      <div
        className={classNames(
          'w-full',
          isVertical
            ? 'flex flex-col gap-2'
            : 'flex flex-wrap items-center justify-between gap-2',
          condensed && 'gap-1',
        )}
      >
        {items.map(
          ({ id, label, hint, icon, badge, active, disabled, onSelect }) => (
            <button
              key={id}
              type="button"
              data-active={active ? 'true' : undefined}
              className={classNames(
                'lg-nav-tab lg-blur-veil',
                isVertical ? 'justify-between' : 'items-center',
                condensed
                  ? 'text-[0.65rem] tracking-[0.16em]'
                  : 'text-xs tracking-[0.12em]',
                active && 'lg-text-glow',
                disabled && 'opacity-50 pointer-events-none',
              )}
              onClick={onSelect}
              disabled={disabled}
            >
              <span className="flex items-center gap-2">
                {icon && (
                  <span className="text-base leading-none opacity-80">
                    {icon}
                  </span>
                )}
                <span className="font-medium uppercase">{label}</span>
              </span>
              <span className="flex items-center gap-2">
                {hint && (
                  <span className="text-[0.6rem] uppercase opacity-70">
                    {hint}
                  </span>
                )}
                {badge && (
                  <span className="rounded-full border border-white/30 px-2 py-[0.1rem] text-[0.6rem] uppercase tracking-[0.25em]">
                    {badge}
                  </span>
                )}
              </span>
            </button>
          ),
        )}
      </div>
    </GlassPanel>
  );
};
