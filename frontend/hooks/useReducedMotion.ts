import { useMediaQuery } from './useMediaQuery';

/**
 * Hook that detects whether the user prefers reduced motion.
 * Use this to conditionally disable or simplify animations.
 *
 * @example
 * const reducedMotion = useReducedMotion();
 * return <div className={reducedMotion ? '' : 'animate-morph-in'}>...</div>;
 */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
