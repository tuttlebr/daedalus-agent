/**
 * useAutoScroll - Manages scroll behavior for chat interfaces
 *
 * Features:
 * - Auto-scrolls to bottom when new content arrives
 * - Detects user scroll interactions and locks auto-scroll
 * - Provides scroll-to-bottom button visibility state
 * - Handles PWA keyboard interactions
 * - Throttled scrolling during streaming to prevent jank
 */

import { useCallback, useRef, useState, useEffect, RefObject } from 'react';
import { throttle } from '@/utils/data/throttle';

export interface UseAutoScrollOptions {
  /** Threshold distance from bottom to consider "at bottom" */
  threshold?: number;
  /** Mobile threshold (typically larger for touch devices) */
  mobileThreshold?: number;
  /** Throttle interval for scroll-down during streaming */
  throttleMs?: number;
  /** Whether the chat is currently streaming */
  isStreaming?: boolean;
  /** Content length of last assistant message (for streaming detection) */
  lastAssistantContentLength?: number;
  /** Whether in PWA mode */
  isPWA?: boolean;
  /** Keyboard offset in PWA mode */
  keyboardOffset?: number;
}

export interface UseAutoScrollReturn {
  /** Whether auto-scroll is enabled */
  autoScrollEnabled: boolean;
  /** Whether user has manually scrolled up (locks auto-scroll) */
  userScrollLocked: boolean;
  /** Whether to show the scroll-down button */
  showScrollDownButton: boolean;
  /** Handle scroll event - attach to container */
  handleScroll: () => void;
  /** Scroll to bottom (user-initiated) */
  scrollToBottom: () => void;
  /** Scroll down during streaming (throttled) */
  scrollDownIfNeeded: () => void;
  /** Reset scroll state (e.g., on conversation change) */
  resetScrollState: () => void;
  /** Check if near bottom of container */
  isNearBottom: (threshold?: number) => boolean;
  /** Get distance from bottom of container */
  getDistanceFromBottom: () => number;
}

/**
 * Detect if running on mobile device
 */
function detectMobile(): boolean {
  if (typeof window === 'undefined') return false;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  ) || window.innerWidth <= 768;
}

export function useAutoScroll(
  containerRef: RefObject<HTMLDivElement>,
  options: UseAutoScrollOptions = {}
): UseAutoScrollReturn {
  const {
    threshold = 50,
    mobileThreshold = 150,
    throttleMs = 500,
    isStreaming = false,
    lastAssistantContentLength = 0,
    isPWA = false,
    keyboardOffset = 0,
  } = options;

  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [userScrollLocked, setUserScrollLocked] = useState(false);
  const [showScrollDownButton, setShowScrollDownButton] = useState(false);

  // Refs for tracking scroll state
  const lastScrollTop = useRef(0);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const autoScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastStreamedContentLengthRef = useRef(0);

  const isMobile = detectMobile();
  const effectiveThreshold = isMobile ? mobileThreshold : threshold;

  /**
   * Get distance from bottom of scroll container
   */
  const getDistanceFromBottom = useCallback((): number => {
    if (!containerRef.current) return Number.POSITIVE_INFINITY;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    return scrollHeight - scrollTop - clientHeight;
  }, [containerRef]);

  /**
   * Check if scroll position is near bottom
   */
  const isNearBottom = useCallback(
    (customThreshold?: number): boolean => {
      const th = customThreshold ?? effectiveThreshold;
      return getDistanceFromBottom() <= th;
    },
    [getDistanceFromBottom, effectiveThreshold]
  );

  /**
   * Handle scroll events - detects user scroll interactions
   */
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceFromBottom <= effectiveThreshold;

    // Immediate reaction to user scroll to avoid race with auto-scroll
    if (!atBottom) {
      if (autoScrollEnabled || !userScrollLocked) {
        setAutoScrollEnabled(false);
        setUserScrollLocked(true);
      }
      setShowScrollDownButton(true);
    } else {
      setShowScrollDownButton(false);
      if (!autoScrollEnabled) {
        setAutoScrollEnabled(true);
      }
      if (userScrollLocked) {
        setUserScrollLocked(false);
      }
    }

    // Debounce scroll position tracking
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = setTimeout(() => {
      lastScrollTop.current = container.scrollTop;
    }, 50);
  }, [autoScrollEnabled, userScrollLocked, effectiveThreshold, containerRef]);

  /**
   * User-initiated scroll to bottom
   */
  const scrollToBottom = useCallback(() => {
    // In PWA mode, don't scroll when keyboard is visible
    if (isPWA && keyboardOffset > 0) {
      return;
    }

    // Clear any pending timeouts
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
    }
    if (autoScrollTimeoutRef.current) {
      clearTimeout(autoScrollTimeoutRef.current);
      autoScrollTimeoutRef.current = null;
    }

    if (containerRef.current) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }

    setUserScrollLocked(false);
    setAutoScrollEnabled(true);
    setShowScrollDownButton(false);
  }, [isPWA, keyboardOffset, containerRef]);

  /**
   * Internal scroll down (for streaming)
   */
  const scrollDown = useCallback(() => {
    if (userScrollLocked) {
      return;
    }

    // In PWA mode, don't auto-scroll when keyboard is appearing
    if (isPWA && keyboardOffset > 0) {
      return;
    }

    // Only scroll if auto-scroll is enabled
    if (autoScrollEnabled && containerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

      // Only scroll if not already near bottom
      if (distanceFromBottom > effectiveThreshold) {
        requestAnimationFrame(() => {
          if (containerRef.current && autoScrollEnabled && !userScrollLocked) {
            containerRef.current.scrollTo({
              top: containerRef.current.scrollHeight,
              behavior: 'auto',
            });
          }
        });
      }
    }
  }, [userScrollLocked, isPWA, keyboardOffset, autoScrollEnabled, containerRef, effectiveThreshold]);

  /**
   * Throttled scroll down for streaming
   */
  const throttledScrollDown = useRef(throttle(scrollDown, throttleMs)).current;

  /**
   * Scroll down if needed (during streaming)
   */
  const scrollDownIfNeeded = useCallback(() => {
    if (!autoScrollEnabled || userScrollLocked) {
      return;
    }

    const streamingThreshold = isMobile ? 220 : 80;
    if (isNearBottom(streamingThreshold)) {
      throttledScrollDown();
    }
  }, [autoScrollEnabled, userScrollLocked, isNearBottom, throttledScrollDown, isMobile]);

  /**
   * Reset scroll state (for conversation changes)
   */
  const resetScrollState = useCallback(() => {
    setAutoScrollEnabled(true);
    setUserScrollLocked(false);
    setShowScrollDownButton(false);
    lastStreamedContentLengthRef.current = 0;

    // Clear timeouts
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
    }
    if (autoScrollTimeoutRef.current) {
      clearTimeout(autoScrollTimeoutRef.current);
      autoScrollTimeoutRef.current = null;
    }
  }, []);

  // Auto-scroll when streaming content grows
  useEffect(() => {
    if (!isStreaming) {
      lastStreamedContentLengthRef.current = 0;
      return;
    }

    if (
      autoScrollEnabled &&
      !userScrollLocked &&
      lastAssistantContentLength > lastStreamedContentLengthRef.current
    ) {
      scrollDownIfNeeded();
    }

    lastStreamedContentLengthRef.current = lastAssistantContentLength;
  }, [
    isStreaming,
    lastAssistantContentLength,
    autoScrollEnabled,
    userScrollLocked,
    scrollDownIfNeeded,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (autoScrollTimeoutRef.current) {
        clearTimeout(autoScrollTimeoutRef.current);
      }
    };
  }, []);

  // Lock scroll on user wheel/touch events (throttled to avoid excessive state updates)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const lockOnUserScroll = throttle(() => {
      if (!isNearBottom()) {
        setAutoScrollEnabled(false);
        setUserScrollLocked(true);
        setShowScrollDownButton(true);
      }
    }, 100);

    container.addEventListener('wheel', lockOnUserScroll, { passive: true });
    container.addEventListener('touchmove', lockOnUserScroll, { passive: true });

    return () => {
      container.removeEventListener('wheel', lockOnUserScroll);
      container.removeEventListener('touchmove', lockOnUserScroll);
    };
  }, [containerRef, isNearBottom]);

  return {
    autoScrollEnabled,
    userScrollLocked,
    showScrollDownButton,
    handleScroll,
    scrollToBottom,
    scrollDownIfNeeded,
    resetScrollState,
    isNearBottom,
    getDistanceFromBottom,
  };
}
