import { memoize } from 'lodash';

// Memoize expensive markdown processing
export const memoizedPrepareContent = memoize(
  (content: string, role: 'user' | 'assistant') => {
    if (role === 'user') return content.trim();

    // Process content for assistant messages
    return content?.trim()?.replace(/\n\s+/, '\n ');
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

// Set up periodic cache clearing (every 5 minutes)
if (typeof window !== 'undefined') {
  setInterval(clearMemoizationCache, 5 * 60 * 1000);
}
