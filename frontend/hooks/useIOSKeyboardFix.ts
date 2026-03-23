import { useEffect, useState, useCallback } from 'react';

interface UseIOSKeyboardFixReturn {
  isKeyboardVisible: boolean;
  keyboardHeight: number;
  viewportHeight: number;
}

export const useIOSKeyboardFix = (): UseIOSKeyboardFixReturn => {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    typeof window !== 'undefined' ? window.innerHeight : 0
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Check if iOS or Android (mobile devices)
    // We want this to run on any mobile device to detect keyboard
    const isMobile = typeof navigator !== 'undefined' && /iPad|iPhone|iPod|Android/.test(navigator.userAgent) && !(window as any).MSStream;

    // Run on mobile AND in standard browser window resizing to test responsiveness
    if (!isMobile && typeof window !== 'undefined' && window.innerWidth > 1024) {
       // Only return early for large desktop screens where virtual keyboard isn't a concern
       // but still allow smaller windows (dev tools responsive mode) to trigger logic
       // return;
    }

    // Store initial viewport height
    const initialHeight = window.innerHeight;
    let lastHeight = initialHeight;
    const pendingTimers: ReturnType<typeof setTimeout>[] = [];

    // Function to handle viewport changes
    const handleViewportChange = () => {
      const currentHeight = window.visualViewport
        ? window.visualViewport.height
        : window.innerHeight;

      setViewportHeight(currentHeight);

      // Detect keyboard by comparing heights
      const heightDifference = initialHeight - currentHeight;
      const keyboardVisible = heightDifference > 50; // Lower threshold for iOS

      setIsKeyboardVisible(keyboardVisible);
      setKeyboardHeight(keyboardVisible ? heightDifference : 0);

      // If keyboard just appeared, prevent page scroll
      if (keyboardVisible && currentHeight < lastHeight) {
        // Body locking removed to allow native resizing
      } else if (!keyboardVisible && currentHeight > lastHeight) {
        // Body locking removed to allow native resizing
      }

      lastHeight = currentHeight;
    };

    // Handle focus events
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
        // In PWA mode, don't use scrollTo - let visualViewport handle positioning
        const isPWA = window.matchMedia('(display-mode: standalone)').matches ||
                      (window.navigator as any).standalone === true;

        // Delay to let keyboard animation start
        const timer = setTimeout(() => {
          handleViewportChange();

          // Ensure input is visible (browser mode only)
          if (!isPWA && window.visualViewport && window.visualViewport.offsetTop > 0) {
            window.scrollTo(0, 0);
          }
        }, 300);
        pendingTimers.push(timer);
      }
    };

    const handleFocusOut = () => {
      const timer = setTimeout(handleViewportChange, 300);
      pendingTimers.push(timer);
    };

    // Initial check
    handleViewportChange();

    // Add event listeners
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleViewportChange);
      window.visualViewport.addEventListener('scroll', handleViewportChange);
    }
    window.addEventListener('resize', handleViewportChange);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);

    return () => {
      pendingTimers.forEach(clearTimeout);

      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleViewportChange);
        window.visualViewport.removeEventListener('scroll', handleViewportChange);
      }
      window.removeEventListener('resize', handleViewportChange);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);

      // Reset body styles
      // document.body.style.position = '';
      // document.body.style.width = '';
      // document.body.style.top = '';
    };
  }, []);

  return {
    isKeyboardVisible,
    keyboardHeight,
    viewportHeight,
  };
};
