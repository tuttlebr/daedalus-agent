import { useEffect, useState } from 'react';
import { throttle } from 'lodash';

export const useVisualViewport = () => {
  const [keyboardOffset, setKeyboardOffset] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) {
      return;
    }

    const updateKeyboardOffset = throttle(() => {
      if (!window.visualViewport) return;

      const visualViewportHeight = window.visualViewport.height;
      const layoutViewportHeight = window.innerHeight;
      const offset = layoutViewportHeight - visualViewportHeight;

      setKeyboardOffset(Math.max(0, offset));

      document.documentElement.style.setProperty(
        '--keyboard-offset',
        `${Math.max(0, offset)}px`
      );
    }, 150, { leading: true, trailing: true });

    updateKeyboardOffset();

    window.visualViewport.addEventListener('resize', updateKeyboardOffset);
    window.visualViewport.addEventListener('scroll', updateKeyboardOffset);

    return () => {
      updateKeyboardOffset.cancel();
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', updateKeyboardOffset);
        window.visualViewport.removeEventListener('scroll', updateKeyboardOffset);
      }
    };
  }, []);

  return keyboardOffset;
};
