'use client';

import React, { memo } from 'react';
import classNames from 'classnames';

// =============================================================================
// BADGE VARIANTS & SIZES
// =============================================================================

type BadgeVariant = 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info';
type BadgeSize = 'xs' | 'sm' | 'md' | 'lg';

const variantClasses: Record<BadgeVariant, string> = {
  default: `
    bg-neutral-100 dark:bg-neutral-800
    text-neutral-700 dark:text-neutral-300
    border border-neutral-200 dark:border-neutral-700
  `,
  primary: `
    bg-nvidia-green/15 text-nvidia-green
    border border-nvidia-green/30
  `,
  secondary: `
    bg-neutral-500/15 text-neutral-600 dark:text-neutral-400
    border border-neutral-500/30
  `,
  success: `
    bg-[#1d8ba4]/15 text-[#1d8ba4] dark:text-[#1dbba4]
    border border-[#1d8ba4]/30
  `,
  warning: `
    bg-[#ef9100]/15 text-[#c67800] dark:text-[#f5a933]
    border border-[#ef9100]/30
  `,
  error: `
    bg-[#e52020]/15 text-[#c51a1a] dark:text-[#f04545]
    border border-[#e52020]/30
  `,
  info: `
    bg-[#0074df]/15 text-[#005bb5] dark:text-[#3399ff]
    border border-[#0074df]/30
  `,
};

const sizeClasses: Record<BadgeSize, string> = {
  xs: 'px-1.5 py-0.5 text-[10px] rounded-[18px]',
  sm: 'px-2 py-1 text-xs rounded-[18px]',
  md: 'px-2.5 py-1 text-sm rounded-[18px]',
  lg: 'px-3 py-1.5 text-sm rounded-[18px]',
};

// =============================================================================
// BADGE COMPONENT
// =============================================================================

interface BadgeProps {
  /** Badge content */
  children: React.ReactNode;
  variant?: BadgeVariant;
  size?: BadgeSize;
  /** Optional icon to display before the text */
  icon?: React.ReactNode;
  /** Whether to show a dot indicator */
  dot?: boolean;
  /** Dot color (if different from text) */
  dotColor?: string;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Badge - Small label for status, counts, or categories
 *
 * Variants:
 * - default: Neutral styling
 * - primary: NVIDIA green
 * - secondary: Subtle neutral
 * - success: Green for positive states
 * - warning: Amber for warnings
 * - error: Red for errors
 * - info: Blue for informational
 */
export const Badge = memo(({
  children,
  variant = 'default',
  size = 'sm',
  icon,
  dot = false,
  dotColor,
  className = '',
}: BadgeProps) => {
  return (
    <span
      className={classNames(
        // Base styles
        'inline-flex items-center gap-1.5 font-medium',
        'whitespace-nowrap select-none',
        // Variant
        variantClasses[variant],
        // Size
        sizeClasses[size],
        // Custom classes
        className
      )}
    >
      {/* Dot indicator */}
      {dot && (
        <span
          className={classNames(
            'w-1.5 h-1.5 rounded-full flex-shrink-0',
            !dotColor && 'bg-current'
          )}
          style={dotColor ? { backgroundColor: dotColor } : undefined}
        />
      )}

      {/* Icon */}
      {icon && (
        <span className="flex-shrink-0">{icon}</span>
      )}

      {/* Content */}
      {children}
    </span>
  );
});

Badge.displayName = 'Badge';

// =============================================================================
// STATUS BADGE - Predefined badges for common statuses
// =============================================================================

interface StatusBadgeProps {
  status: 'online' | 'offline' | 'busy' | 'away' | 'idle' | 'streaming' | 'processing';
  showLabel?: boolean;
  size?: BadgeSize;
  className?: string;
}

// NVIDIA Brand Colors from COLORS.md for status indicators
const NVIDIA_COLORS = {
  green: '#76b900',      // Primary - NVIDIA Green
  teal: '#1d8ba4',       // Supporting - Teal (success)
  red: '#e52020',        // Functional - Red (error)
  orange: '#ef9100',     // Complimentary - Orange (warning)
  blue: '#0074df',       // Functional - Blue (info)
  neutral: '#737373',    // Neutral gray
  neutralLight: '#a3a3a3', // Light neutral gray
} as const;

const statusConfig: Record<StatusBadgeProps['status'], { variant: BadgeVariant; label: string; dotColor: string }> = {
  online: { variant: 'success', label: 'Online', dotColor: NVIDIA_COLORS.teal },
  offline: { variant: 'default', label: 'Offline', dotColor: NVIDIA_COLORS.neutral },
  busy: { variant: 'error', label: 'Busy', dotColor: NVIDIA_COLORS.red },
  away: { variant: 'warning', label: 'Away', dotColor: NVIDIA_COLORS.orange },
  idle: { variant: 'secondary', label: 'Idle', dotColor: NVIDIA_COLORS.neutralLight },
  streaming: { variant: 'primary', label: 'Streaming', dotColor: NVIDIA_COLORS.green },
  processing: { variant: 'info', label: 'Processing', dotColor: NVIDIA_COLORS.blue },
};

export const StatusBadge = memo(({
  status,
  showLabel = true,
  size = 'sm',
  className = '',
}: StatusBadgeProps) => {
  const config = statusConfig[status];

  return (
    <Badge
      variant={config.variant}
      size={size}
      dot
      dotColor={config.dotColor}
      className={className}
    >
      {showLabel && config.label}
    </Badge>
  );
});

StatusBadge.displayName = 'StatusBadge';

// =============================================================================
// COUNT BADGE - For notification counts, unread messages, etc.
// =============================================================================

interface CountBadgeProps {
  count: number;
  /** Maximum count to display (shows "max+" for larger values) */
  max?: number;
  variant?: BadgeVariant;
  size?: BadgeSize;
  className?: string;
}

export const CountBadge = memo(({
  count,
  max = 99,
  variant = 'primary',
  size = 'xs',
  className = '',
}: CountBadgeProps) => {
  if (count <= 0) return null;

  const displayCount = count > max ? `${max}+` : count.toString();

  return (
    <Badge
      variant={variant}
      size={size}
      className={classNames(
        'min-w-[1.25rem] justify-center',
        className
      )}
    >
      {displayCount}
    </Badge>
  );
});

CountBadge.displayName = 'CountBadge';

export default Badge;
