/**
 * Shared UI Component Library
 *
 * Provides consistent, reusable UI components across the application.
 * All components follow the NVIDIA design system with glass morphism aesthetics.
 */

// =============================================================================
// BUTTONS
// =============================================================================

export { Button, ButtonGroup } from './Button';
export { default as ButtonDefault } from './Button';

export { IconButton, IconButtonGroup } from './IconButton';
export { default as IconButtonDefault } from './IconButton';

// =============================================================================
// BADGES & LABELS
// =============================================================================

export { Badge, StatusBadge, CountBadge } from './Badge';
export { default as BadgeDefault } from './Badge';

// =============================================================================
// LOADING STATES
// =============================================================================

export {
  Skeleton,
  MessageSkeleton,
  ConversationSkeleton,
  ChatLoadingSkeleton,
  IntermediateStepsSkeleton,
  CardSkeleton,
  ImageSkeleton,
  SkeletonGroup,
} from './Skeleton';
export { default as SkeletonDefault } from './Skeleton';

// Re-export LoadingSkeleton for backward compatibility
export * from './LoadingSkeleton';

// =============================================================================
// IMAGES
// =============================================================================

export { NextImage, AvatarImage, BackgroundImage } from './NextImage';
export { default as NextImageDefault } from './NextImage';
