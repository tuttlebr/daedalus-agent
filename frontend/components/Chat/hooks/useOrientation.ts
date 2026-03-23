'use client';

import { useState, useEffect, useCallback } from 'react';

interface UseOrientationReturn {
  /** Whether the viewport is in landscape orientation */
  isLandscape: boolean;
  /** Whether the viewport is in portrait orientation */
  isPortrait: boolean;
  /** Whether on a mobile device */
  isMobile: boolean;
  /** Whether on a touch device */
  isTouchDevice: boolean;
  /** Whether running as a PWA */
  isPWA: boolean;
}

/**
 * Custom hook for detecting device orientation and type
 */
export function useOrientation(): UseOrientationReturn {
  const [isLandscape, setIsLandscape] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [isPWA, setIsPWA] = useState(false);

  const checkOrientation = useCallback(() => {
    if (typeof window === 'undefined') return;
    setIsLandscape(window.innerWidth > window.innerHeight);
  }, []);

  const checkDeviceType = useCallback(() => {
    if (typeof window === 'undefined') return;

    // Check if mobile based on pointer type and screen width
    setIsMobile(
      window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 768
    );

    // Check if touch device
    setIsTouchDevice(
      'ontouchstart' in window || navigator.maxTouchPoints > 0
    );

    // Check if PWA
    setIsPWA(
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  }, []);

  useEffect(() => {
    checkOrientation();
    checkDeviceType();

    window.addEventListener('resize', checkOrientation);
    window.addEventListener('orientationchange', checkOrientation);

    return () => {
      window.removeEventListener('resize', checkOrientation);
      window.removeEventListener('orientationchange', checkOrientation);
    };
  }, [checkOrientation, checkDeviceType]);

  return {
    isLandscape,
    isPortrait: !isLandscape,
    isMobile,
    isTouchDevice,
    isPWA,
  };
}

export default useOrientation;
