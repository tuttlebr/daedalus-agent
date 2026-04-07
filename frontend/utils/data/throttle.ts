export interface ThrottleOptions {
  leading?: boolean;
  trailing?: boolean;
}

export interface ThrottledFunction<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): void;
  cancel(): void;
}

export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number,
  options?: ThrottleOptions,
): ThrottledFunction<T> {
  const leading = options?.leading !== false;   // default true
  const trailing = options?.trailing !== false;  // default true

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastRan = 0;
  let lastArgs: Parameters<T> | null = null;

  const throttled = ((...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = limit - (now - lastRan);

    if (remaining <= 0 || remaining > limit) {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (leading || lastRan !== 0) {
        lastRan = now;
        func(...args);
      } else {
        lastRan = now;
      }
      lastArgs = null;
    } else {
      lastArgs = args;
      if (timeoutId === null && trailing) {
        timeoutId = setTimeout(() => {
          lastRan = leading ? Date.now() : 0;
          timeoutId = null;
          if (lastArgs !== null) {
            func(...lastArgs);
            lastArgs = null;
          }
        }, remaining);
      }
    }
  }) as ThrottledFunction<T>;

  throttled.cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    lastRan = 0;
    lastArgs = null;
  };

  return throttled;
}
