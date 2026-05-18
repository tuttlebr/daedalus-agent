import { useEffect, useState } from 'react';

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

    const initialHeight = window.innerHeight;
    const pendingTimers: ReturnType<typeof setTimeout>[] = [];

    const handleViewportChange = () => {
      const currentHeight = window.visualViewport
        ? window.visualViewport.height
        : window.innerHeight;

      setViewportHeight(currentHeight);

      const heightDifference = initialHeight - currentHeight;
      const keyboardVisible = heightDifference > 50;

      setIsKeyboardVisible(keyboardVisible);
      setKeyboardHeight(keyboardVisible ? heightDifference : 0);
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
    };
  }, []);

  return {
    isKeyboardVisible,
    keyboardHeight,
    viewportHeight,
  };
};
