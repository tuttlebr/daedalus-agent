'use client';

import { useCallback, useEffect, useRef } from 'react';

interface UseTextareaResizeOptions {
  /** Minimum height in pixels */
  minHeight?: number;
  /** Maximum height in pixels */
  maxHeight?: number;
  /** Whether to reset height when content is cleared */
  resetOnEmpty?: boolean;
}

interface UseTextareaResizeReturn {
  /** Ref to attach to the textarea */
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  /** Manually trigger resize */
  resizeTextarea: () => void;
  /** Reset textarea to minimum height */
  resetHeight: () => void;
}

/**
 * Custom hook for auto-resizing textarea based on content
 */
export function useTextareaResize({
  minHeight = 56,
  maxHeight = 400,
  resetOnEmpty = true,
}: UseTextareaResizeOptions = {}): UseTextareaResizeReturn {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Resize the textarea based on content
  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to min to get accurate scrollHeight
    textarea.style.height = `${minHeight}px`;

    // Calculate new height based on content
    const scrollHeight = textarea.scrollHeight;
    const newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);

    textarea.style.height = `${newHeight}px`;

    // Handle overflow based on whether we've hit max height
    if (scrollHeight > maxHeight) {
      textarea.style.overflowY = 'auto';
    } else {
      textarea.style.overflowY = 'hidden';
    }
  }, [minHeight, maxHeight]);

  // Reset to minimum height
  const resetHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = `${minHeight}px`;
    textarea.style.overflowY = 'hidden';
  }, [minHeight]);

  // Set up input listener for auto-resize
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const handleInput = () => {
      if (resetOnEmpty && textarea.value === '') {
        resetHeight();
      } else {
        resizeTextarea();
      }
    };

    textarea.addEventListener('input', handleInput);

    // Initial resize
    resizeTextarea();

    return () => {
      textarea.removeEventListener('input', handleInput);
    };
  }, [resizeTextarea, resetHeight, resetOnEmpty]);

  return {
    textareaRef,
    resizeTextarea,
    resetHeight,
  };
}

export default useTextareaResize;
