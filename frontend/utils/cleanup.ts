/**
 * Cleanup Utilities for Event Listeners and Async Operations
 *
 * Provides safer patterns for managing event listeners, timeouts, and intervals
 * in React components to prevent memory leaks.
 */

/**
 * Creates a cleanup registry for managing multiple cleanup functions.
 * Useful for components with many event listeners or timeouts.
 *
 * @example
 * ```tsx
 * const cleanup = createCleanupRegistry();
 *
 * useEffect(() => {
 *   cleanup.add(() => window.removeEventListener('resize', handler));
 *   cleanup.add(() => clearTimeout(timeoutId));
 *
 *   return () => cleanup.clear();
 * }, []);
 * ```
 */
export function createCleanupRegistry() {
  const cleanupFns = new Set<() => void>();

  return {
    /**
     * Add a cleanup function to the registry
     */
    add(fn: () => void): () => void {
      cleanupFns.add(fn);
      // Return a remove function for early cleanup
      return () => {
        fn();
        cleanupFns.delete(fn);
      };
    },

    /**
     * Remove a specific cleanup function without calling it
     */
    remove(fn: () => void): void {
      cleanupFns.delete(fn);
    },

    /**
     * Execute all cleanup functions and clear the registry
     */
    clear(): void {
      cleanupFns.forEach((fn) => {
        try {
          fn();
        } catch (error) {
          console.error('Cleanup function error:', error);
        }
      });
      cleanupFns.clear();
    },

    /**
     * Get the number of pending cleanup functions
     */
    get size(): number {
      return cleanupFns.size;
    },
  };
}

/**
 * Type for cleanup registry returned by createCleanupRegistry
 */
export type CleanupRegistry = ReturnType<typeof createCleanupRegistry>;

/**
 * Creates a managed event listener that auto-removes on cleanup.
 *
 * @example
 * ```tsx
 * useEffect(() => {
 *   const remove = addManagedListener(
 *     window,
 *     'resize',
 *     handleResize,
 *     { passive: true }
 *   );
 *   return remove;
 * }, []);
 * ```
 */
export function addManagedListener<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  listener: (ev: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions
): () => void;
export function addManagedListener<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  listener: (ev: DocumentEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions
): () => void;
export function addManagedListener<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  listener: (ev: HTMLElementEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions
): () => void;
export function addManagedListener(
  target: EventTarget,
  type: string,
  listener: EventListener,
  options?: boolean | AddEventListenerOptions
): () => void {
  target.addEventListener(type, listener, options);
  return () => target.removeEventListener(type, listener, options);
}

/**
 * Creates a managed timeout that can be cleared on cleanup.
 *
 * @example
 * ```tsx
 * useEffect(() => {
 *   const clear = setManagedTimeout(() => {
 *     doSomething();
 *   }, 1000);
 *   return clear;
 * }, []);
 * ```
 */
export function setManagedTimeout(
  callback: () => void,
  delay: number
): () => void {
  const timeoutId = setTimeout(callback, delay);
  return () => clearTimeout(timeoutId);
}

/**
 * Creates a managed interval that can be cleared on cleanup.
 *
 * @example
 * ```tsx
 * useEffect(() => {
 *   const clear = setManagedInterval(() => {
 *     checkForUpdates();
 *   }, 5000);
 *   return clear;
 * }, []);
 * ```
 */
export function setManagedInterval(
  callback: () => void,
  delay: number
): () => void {
  const intervalId = setInterval(callback, delay);
  return () => clearInterval(intervalId);
}

/**
 * Creates a debounced function with built-in cleanup.
 * Returns both the debounced function and a cancel function.
 *
 * @example
 * ```tsx
 * const [debouncedSave, cancelSave] = createDebouncedFn(save, 300);
 *
 * useEffect(() => {
 *   return cancelSave;
 * }, []);
 * ```
 */
export function createDebouncedFn<T extends (...args: any[]) => void>(
  fn: T,
  delay: number
): [T, () => void] {
  let timeoutId: NodeJS.Timeout | null = null;

  const debouncedFn = ((...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  }) as T;

  const cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return [debouncedFn, cancel];
}

/**
 * Creates a throttled function with built-in cleanup.
 * Returns both the throttled function and a cancel function.
 *
 * @example
 * ```tsx
 * const [throttledScroll, cancelThrottle] = createThrottledFn(handleScroll, 100);
 *
 * useEffect(() => {
 *   window.addEventListener('scroll', throttledScroll);
 *   return () => {
 *     window.removeEventListener('scroll', throttledScroll);
 *     cancelThrottle();
 *   };
 * }, []);
 * ```
 */
export function createThrottledFn<T extends (...args: any[]) => void>(
  fn: T,
  limit: number
): [T, () => void] {
  let lastCall = 0;
  let timeoutId: NodeJS.Timeout | null = null;

  const throttledFn = ((...args: Parameters<T>) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;

    if (timeSinceLastCall >= limit) {
      lastCall = now;
      fn(...args);
    } else {
      // Schedule trailing call
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        fn(...args);
        timeoutId = null;
      }, limit - timeSinceLastCall);
    }
  }) as T;

  const cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return [throttledFn, cancel];
}

/**
 * Helper to safely execute a cleanup function, catching any errors.
 *
 * @example
 * ```tsx
 * return () => {
 *   safeCleanup(() => controller.abort());
 *   safeCleanup(() => clearTimeout(timeoutId));
 * };
 * ```
 */
export function safeCleanup(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

/**
 * Creates a ref-stable callback that always calls the latest version.
 * Useful for event handlers that need to access latest state/props.
 *
 * Note: This is a utility function, not a hook. Use with useRef in components.
 *
 * @example
 * ```tsx
 * const callbackRef = useRef(callback);
 * callbackRef.current = callback;
 *
 * const stableCallback = useCallback(
 *   createStableCallback(callbackRef),
 *   []
 * );
 * ```
 */
export function createStableCallback<T extends (...args: any[]) => any>(
  ref: { current: T }
): T {
  return ((...args: Parameters<T>) => ref.current(...args)) as T;
}

/**
 * Combines multiple cleanup functions into a single cleanup function.
 *
 * @example
 * ```tsx
 * return combineCleanup(
 *   () => clearTimeout(timeout1),
 *   () => clearTimeout(timeout2),
 *   () => window.removeEventListener('resize', handler)
 * );
 * ```
 */
export function combineCleanup(...cleanupFns: Array<(() => void) | undefined | null>): () => void {
  return () => {
    cleanupFns.forEach((fn) => {
      if (fn) {
        safeCleanup(fn);
      }
    });
  };
}
