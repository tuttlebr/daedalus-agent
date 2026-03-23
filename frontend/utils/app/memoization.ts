import { memoize } from 'lodash';
import { createVisibilityAwareInterval } from './visibilityAwareTimer';

// Memoize expensive markdown processing
export const memoizedPrepareContent = memoize(
  (content: string, role: 'user' | 'assistant') => {
    if (role === 'user') return content.trim();

    // Process content for assistant messages - just trim, let markdown renderer handle formatting
    return content?.trim();
  },
  (content, role) => `${content}-${role}` // Cache key
);

// Memoize image processing checks
export const memoizedCheckForImages = memoize(
  (content: string): boolean => {
    if (!content) return false;
    return content.includes('![') || content.includes('<img') || content.includes('base64');
  }
);

// Clear memoization cache periodically to prevent memory bloat
export const clearMemoizationCache = () => {
  memoizedPrepareContent.cache.clear?.();
  memoizedCheckForImages.cache.clear?.();
};

// Set up visibility-aware cache clearing (every 10 minutes, pauses when hidden)
// Uses longer interval on mobile (20 min) to save battery
if (typeof window !== 'undefined') {
  createVisibilityAwareInterval(clearMemoizationCache, {
    interval: 10 * 60 * 1000, // 10 minutes
    mobileMultiplier: 2,      // 20 minutes on mobile
    pauseWhenHidden: true,
  });
}
