import { useEffect, useState } from 'react';

export const useKeyboardVisibility = () => {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    typeof window !== 'undefined' ? window.innerHeight : 0
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Store initial viewport height
    const initialHeight = window.innerHeight;
    let currentHeight = initialHeight;

    // Function to detect keyboard visibility
    const handleViewportChange = () => {
      const newHeight = window.innerHeight;
      const heightDifference = initialHeight - newHeight;

      // Keyboard is likely visible if viewport shrinks by more than 100px
      if (heightDifference > 100) {
        setIsKeyboardVisible(true);
        setKeyboardHeight(heightDifference);
      } else {
        setIsKeyboardVisible(false);
        setKeyboardHeight(0);
      }

      setViewportHeight(newHeight);
      currentHeight = newHeight;
    };

    // Visual Viewport API (better for mobile)
    if ('visualViewport' in window && window.visualViewport) {
      const handleVisualViewportChange = () => {
        const visualViewport = window.visualViewport;
        if (!visualViewport) return;

        const keyboardHeight = window.innerHeight - visualViewport.height;
        setIsKeyboardVisible(keyboardHeight > 100);
        setKeyboardHeight(keyboardHeight);
        setViewportHeight(visualViewport.height);
      };

      window.visualViewport.addEventListener('resize', handleVisualViewportChange);
      window.visualViewport.addEventListener('scroll', handleVisualViewportChange);

      return () => {
        window.visualViewport?.removeEventListener('resize', handleVisualViewportChange);
        window.visualViewport?.removeEventListener('scroll', handleVisualViewportChange);
      };
    } else {
      // Fallback for browsers without Visual Viewport API
      window.addEventListener('resize', handleViewportChange);

      // Also listen for focus/blur on inputs
      const handleFocus = () => {
        setTimeout(handleViewportChange, 300); // Wait for keyboard animation
      };

      const handleBlur = () => {
        setTimeout(() => {
          setIsKeyboardVisible(false);
          setKeyboardHeight(0);
          handleViewportChange();
        }, 300);
      };

      // Add listeners to all inputs and textareas
      document.addEventListener('focusin', handleFocus);
      document.addEventListener('focusout', handleBlur);

      return () => {
        window.removeEventListener('resize', handleViewportChange);
        document.removeEventListener('focusin', handleFocus);
        document.removeEventListener('focusout', handleBlur);
      };
    }
  }, []);

  return {
    isKeyboardVisible,
    keyboardHeight,
    viewportHeight,
  };
};
