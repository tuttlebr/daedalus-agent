'use client';

import React, { forwardRef, memo } from 'react';
import classNames from 'classnames';

// =============================================================================
// ICON BUTTON VARIANTS & SIZES
// =============================================================================

type IconButtonVariant = 'default' | 'ghost' | 'solid' | 'accent' | 'outline' | 'danger';
type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const variantClasses: Record<IconButtonVariant, string> = {
  default: `
    bg-neutral-100/80 dark:bg-neutral-800/60
    text-neutral-600 dark:text-neutral-400
    hover:bg-neutral-200 dark:hover:bg-neutral-700
    hover:text-neutral-900 dark:hover:text-neutral-100
    active:scale-95
    focus-visible:ring-2 focus-visible:ring-neutral-400/40
  `,
  ghost: `
    bg-transparent
    text-neutral-500 dark:text-neutral-400
    hover:bg-neutral-100 dark:hover:bg-neutral-800
    hover:text-neutral-900 dark:hover:text-neutral-100
    active:scale-95
    focus-visible:ring-2 focus-visible:ring-neutral-400/40
  `,
  solid: `
    bg-black dark:bg-white text-white dark:text-black
    hover:bg-neutral-800 dark:hover:bg-neutral-200
    active:scale-95
    focus-visible:ring-2 focus-visible:ring-neutral-400/40
  `,
  accent: `
    bg-nvidia-green text-white
    hover:bg-nvidia-green-dark hover:shadow-[0_0_20px_rgba(118,185,0,0.4)]
    active:scale-95
    focus-visible:ring-2 focus-visible:ring-nvidia-green/40
  `,
  outline: `
    bg-transparent
    border border-neutral-300 dark:border-neutral-600
    text-neutral-600 dark:text-neutral-400
    hover:bg-neutral-100 dark:hover:bg-neutral-800
    hover:border-neutral-400 dark:hover:border-neutral-500
    active:scale-95
    focus-visible:ring-2 focus-visible:ring-neutral-400/40
  `,
  danger: `
    bg-transparent text-neutral-500 dark:text-neutral-400
    hover:bg-red-100 dark:hover:bg-red-900/30
    hover:text-red-600 dark:hover:text-red-400
    active:scale-95
    focus-visible:ring-2 focus-visible:ring-red-500/40
  `,
};

const sizeClasses: Record<IconButtonSize, { button: string; icon: number }> = {
  xs: { button: 'w-6 h-6 rounded-md', icon: 14 },
  sm: { button: 'w-8 h-8 rounded-lg', icon: 16 },
  md: { button: 'w-10 h-10 rounded-lg', icon: 20 },
  lg: { button: 'w-12 h-12 rounded-xl', icon: 24 },
};

// =============================================================================
// ICON BUTTON COMPONENT
// =============================================================================

interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Icon to display */
  icon: React.ReactElement;
  /** Accessible label (required for icon-only buttons) */
  'aria-label': string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  isLoading?: boolean;
  /** Tooltip content (uses title by default) */
  tooltip?: string;
}

/**
 * IconButton - Button with only an icon
 *
 * Always requires an aria-label for accessibility.
 *
 * Variants:
 * - default: Subtle background, neutral colors
 * - ghost: No background until hover
 * - solid: Black/white primary CTA (NVIDIA brand standard)
 * - accent: NVIDIA green, hero accent (use sparingly)
 * - outline: Border only
 * - danger: Red on hover for destructive actions
 */
export const IconButton = memo(forwardRef<HTMLButtonElement, IconButtonProps>(({
  icon,
  'aria-label': ariaLabel,
  variant = 'default',
  size = 'md',
  isLoading = false,
  tooltip,
  disabled,
  className = '',
  ...props
}, ref) => {
  const isDisabled = disabled || isLoading;
  const sizeConfig = sizeClasses[size];

  // Clone the icon with the correct size
  const sizedIcon = React.cloneElement(icon, {
    size: sizeConfig.icon,
    className: classNames(icon.props.className, 'flex-shrink-0'),
  });

  return (
    <button
      ref={ref}
      type="button"
      disabled={isDisabled}
      aria-label={ariaLabel}
      title={tooltip || ariaLabel}
      className={classNames(
        // Base styles
        'inline-flex items-center justify-center',
        'transition-all duration-200 ease-out',
        'focus-visible:outline-none',
        'select-none cursor-pointer',
        // Size
        sizeConfig.button,
        // Variant
        variantClasses[variant],
        // Disabled state
        isDisabled && 'opacity-50 cursor-not-allowed pointer-events-none',
        // Custom classes
        className
      )}
      {...props}
    >
      {isLoading ? (
        <svg
          className="animate-spin"
          style={{ width: sizeConfig.icon, height: sizeConfig.icon }}
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      ) : (
        sizedIcon
      )}
    </button>
  );
}));

IconButton.displayName = 'IconButton';

// =============================================================================
// ICON BUTTON GROUP
// =============================================================================

interface IconButtonGroupProps {
  children: React.ReactNode;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}

export const IconButtonGroup = memo(({
  children,
  orientation = 'horizontal',
  className = '',
}: IconButtonGroupProps) => {
  return (
    <div
      className={classNames(
        'inline-flex gap-1',
        orientation === 'vertical' && 'flex-col',
        className
      )}
      role="group"
    >
      {children}
    </div>
  );
});

IconButtonGroup.displayName = 'IconButtonGroup';

export default IconButton;
