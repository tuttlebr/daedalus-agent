/** iPadOS can request desktop pages while retaining iOS file-save behavior. */
export function isIOS(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
  );
}

export function isStandaloneWebApp(): boolean {
  return (
    typeof window !== 'undefined' &&
    ((navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches)
  );
}
