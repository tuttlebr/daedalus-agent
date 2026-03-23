'use client';

import { useCallback, useRef, useState, useEffect } from 'react';
import { throttle } from '@/utils/data/throttle';

interface UseChatScrollOptions {
  /** Threshold distance from bottom to consider "at bottom" (mobile) */
  mobileThreshold?: number;
  /** Threshold distance from bottom to consider "at bottom" (desktop) */
  desktopThreshold?: number;
  /** Whether the chat is in PWA mode */
  isPWA?: boolean;
  /** Current keyboard offset (for PWA) */
  keyboardOffset?: number;
}

interface UseChatScrollReturn {
  /** Ref to attach to the scrollable container */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Ref to attach to the end marker element */
  endRef: React.RefObject<HTMLDivElement>;
  /** Whether auto-scroll is currently enabled */
  autoScrollEnabled: boolean;
  /** Whether to show the scroll-down button */
  showScrollDownButton: boolean;
  /** Whether the user has manually locked scroll position */
  userScrollLocked: boolean;
  /** Handler for scroll events */
  handleScroll: () => void;
  /** Scroll to the bottom of the container */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** Manually enable/disable auto-scroll */
  setAutoScrollEnabled: (enabled: boolean) => void;
  /** Reset scroll state (for new conversations) */
  resetScrollState: () => void;
  /** Check if currently near bottom */
  isNearBottom: (threshold?: number) => boolean;
  /** Get current distance from bottom */
  getDistanceFromBottom: () => number;
  /** Throttled scroll to bottom for streaming updates */
  throttledScrollToBottom: () => void;
}

/**
 * Custom hook for managing chat scroll behavior
 *
 * Handles:
 * - Auto-scroll during streaming
 * - User scroll detection and lock
 * - Scroll-to-bottom button visibility
 * - PWA keyboard offset handling
 */
export function useChatScroll({
  mobileThreshold = 150,
  desktopThreshold = 50,
  isPWA = false,
  keyboardOffset = 0,
}: UseChatScrollOptions = {}): UseChatScrollReturn {
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [showScrollDownButton, setShowScrollDownButton] = useState(false);
  const [userScrollLocked, setUserScrollLocked] = useState(false);

  // Track last scroll position for detecting scroll direction
  const lastScrollTop = useRef(0);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const autoScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Detect if on mobile device
  const isMobile = useCallback(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 768;
  }, []);

  // Get current threshold based on device
  const getThreshold = useCallback(() => {
    return isMobile() ? mobileThreshold : desktopThreshold;
  }, [isMobile, mobileThreshold, desktopThreshold]);

  // Get distance from bottom of scroll container
  const getDistanceFromBottom = useCallback(() => {
    if (!containerRef.current) return Number.POSITIVE_INFINITY;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    return scrollHeight - scrollTop - clientHeight;
  }, []);

  // Check if near bottom of container
  const isNearBottom = useCallback((threshold?: number) => {
    const effectiveThreshold = threshold ?? getThreshold();
    return getDistanceFromBottom() <= effectiveThreshold;
  }, [getDistanceFromBottom, getThreshold]);

  // Scroll to bottom of container
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
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
        behavior,
      });
    }

    setUserScrollLocked(false);
    setAutoScrollEnabled(true);
    setShowScrollDownButton(false);
  }, [isPWA, keyboardOffset]);

  // Throttled version for streaming updates
  const throttledScrollToBottom = useRef(
    throttle(() => {
      if (!containerRef.current || !autoScrollEnabled || userScrollLocked) return;

      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: 'auto', // Use 'auto' for smoother streaming
      });
    }, 100)
  ).current;

  // Handle scroll events
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const threshold = getThreshold();
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceFromBottom <= threshold;

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

    // Debounced update of last scroll position
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = setTimeout(() => {
      lastScrollTop.current = container.scrollTop;
    }, 50);
  }, [autoScrollEnabled, userScrollLocked, getThreshold]);

  // Reset scroll state for new conversations
  const resetScrollState = useCallback(() => {
    setAutoScrollEnabled(true);
    setShowScrollDownButton(false);
    setUserScrollLocked(false);
    lastScrollTop.current = 0;

    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
    }
    if (autoScrollTimeoutRef.current) {
      clearTimeout(autoScrollTimeoutRef.current);
      autoScrollTimeoutRef.current = null;
    }
  }, []);

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

  return {
    containerRef,
    endRef,
    autoScrollEnabled,
    showScrollDownButton,
    userScrollLocked,
    handleScroll,
    scrollToBottom,
    setAutoScrollEnabled,
    resetScrollState,
    isNearBottom,
    getDistanceFromBottom,
    throttledScrollToBottom,
  };
}

export default useChatScroll;
