import { useState, useEffect } from 'react';

/**
 * Hook that tracks whether a CSS media query matches.
 * Returns false during SSR to avoid hydration mismatches.
 *
 * @example
 * const isMobile = useMediaQuery('(max-width: 767px)');
 * const isDesktop = useMediaQuery('(min-width: 1024px)');
 * const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);

    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

/** Convenience: true when viewport < 768px (md breakpoint) */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)');
}

/** Convenience: true when viewport >= 1024px (lg breakpoint) */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}
