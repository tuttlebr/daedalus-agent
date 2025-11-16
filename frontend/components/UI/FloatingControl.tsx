import React from 'react';
import classNames from 'classnames';

type FloatingTone = 'default' | 'accent' | 'critical';

export interface FloatingControlProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode;
  label: string;
  tone?: FloatingTone;
  active?: boolean;
  hint?: string;
}

export const FloatingControl: React.FC<FloatingControlProps> = ({
  icon,
  label,
  hint,
  tone = 'default',
  active = false,
  className,
  ...rest
}) => (
  <button
    type="button"
    {...rest}
    data-tone={tone === 'default' ? undefined : tone}
    data-active={active ? 'true' : undefined}
    className={classNames('lg-floating-control', className)}
    aria-pressed={active}
  >
    {icon && <span className="text-base leading-none">{icon}</span>}
    <span className="text-xs font-semibold uppercase tracking-[0.08em]">
      {label}
    </span>
    {hint && (
      <span className="text-[0.65rem] uppercase tracking-[0.3em] opacity-80">
        {hint}
      </span>
    )}
  </button>
);

