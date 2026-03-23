/**
 * Re-exports from the new comprehensive Skeleton component system.
 * Maintained for backward compatibility.
 */

// Re-export all skeleton components from the new comprehensive module
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

// Backward-compatible aliases
export { MessageSkeleton as LoadingSkeleton } from './Skeleton';
export { ChatLoadingSkeleton as ChatSkeleton } from './Skeleton';
