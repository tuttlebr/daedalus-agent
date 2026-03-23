'use client';

import { useCallback, useEffect, useRef } from 'react';

const FOCUSABLE_ELEMENTS = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
];

interface UseFocusTrapOptions {
  /** Whether the focus trap is active */
  isActive?: boolean;
  /** Callback when escape key is pressed */
  onEscape?: () => void;
  /** Whether to auto-focus the first element when trap becomes active */
  autoFocus?: boolean;
  /** Whether to restore focus when trap is deactivated */
  restoreFocus?: boolean;
}

interface UseFocusTrapReturn {
  /** Ref to attach to the container element */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Manually focus the first focusable element */
  focusFirst: () => void;
  /** Manually focus the last focusable element */
  focusLast: () => void;
}

/**
 * Custom hook for creating a focus trap within a container
 *
 * Useful for:
 * - Modal dialogs
 * - Dropdown menus
 * - Slide-out panels
 *
 * Features:
 * - Traps focus within the container
 * - Handles Tab and Shift+Tab
 * - Escape key callback
 * - Auto-focus on activation
 * - Focus restoration on deactivation
 */
export function useFocusTrap({
  isActive = true,
  onEscape,
  autoFocus = true,
  restoreFocus = true,
}: UseFocusTrapOptions = {}): UseFocusTrapReturn {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  // Get all focusable elements in the container
  const getFocusableElements = useCallback(() => {
    if (!containerRef.current) return [];
    const elements = containerRef.current.querySelectorAll<HTMLElement>(
      FOCUSABLE_ELEMENTS.join(',')
    );
    return Array.from(elements).filter(
      (el) => el.offsetParent !== null // Exclude hidden elements
    );
  }, []);

  // Focus the first focusable element
  const focusFirst = useCallback(() => {
    const elements = getFocusableElements();
    if (elements.length > 0) {
      elements[0].focus();
    }
  }, [getFocusableElements]);

  // Focus the last focusable element
  const focusLast = useCallback(() => {
    const elements = getFocusableElements();
    if (elements.length > 0) {
      elements[elements.length - 1].focus();
    }
  }, [getFocusableElements]);

  // Handle keyboard events
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!isActive || !containerRef.current) return;

      // Handle Escape key
      if (event.key === 'Escape' && onEscape) {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
        return;
      }

      // Handle Tab key for focus trapping
      if (event.key === 'Tab') {
        const elements = getFocusableElements();
        if (elements.length === 0) return;

        const firstElement = elements[0];
        const lastElement = elements[elements.length - 1];

        // Shift+Tab on first element - wrap to last
        if (event.shiftKey && document.activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
        }
        // Tab on last element - wrap to first
        else if (!event.shiftKey && document.activeElement === lastElement) {
          event.preventDefault();
          firstElement.focus();
        }
      }
    },
    [isActive, onEscape, getFocusableElements]
  );

  // Set up event listener and manage focus
  useEffect(() => {
    if (!isActive) return;

    // Store the previously focused element
    if (restoreFocus) {
      previousActiveElement.current = document.activeElement as HTMLElement;
    }

    // Auto-focus the first element
    if (autoFocus) {
      // Use setTimeout to ensure the DOM has rendered
      const timeoutId = setTimeout(() => {
        focusFirst();
      }, 0);

      document.addEventListener('keydown', handleKeyDown);

      return () => {
        clearTimeout(timeoutId);
        document.removeEventListener('keydown', handleKeyDown);

        // Restore focus to the previously focused element
        if (restoreFocus && previousActiveElement.current) {
          previousActiveElement.current.focus();
        }
      };
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);

      // Restore focus to the previously focused element
      if (restoreFocus && previousActiveElement.current) {
        previousActiveElement.current.focus();
      }
    };
  }, [isActive, autoFocus, restoreFocus, focusFirst, handleKeyDown]);

  return {
    containerRef,
    focusFirst,
    focusLast,
  };
}

export default useFocusTrap;
