/**
 * Visibility-Aware Timer Utility
 *
 * Automatically pauses timers when the page is hidden (backgrounded on mobile)
 * and resumes them when visible again. This significantly reduces battery drain
 * for PWA users on mobile devices.
 */

type TimerCallback = () => void | Promise<void>;

interface TimerOptions {
  /** Interval in milliseconds when app is visible */
  interval: number;
  /** Optional: longer interval when app becomes visible again (one-shot catch-up) */
  runImmediatelyOnVisible?: boolean;
  /** Optional: multiplier for interval on mobile devices (default: 2x) */
  mobileMultiplier?: number;
  /** Optional: only run when document is visible */
  pauseWhenHidden?: boolean;
}

export interface ManagedTimer {
  id: string;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  isRunning: () => boolean;
}

// Track all managed timers for global visibility handling
const managedTimers = new Map<string, {
  callback: TimerCallback;
  options: TimerOptions;
  intervalId: ReturnType<typeof setInterval> | null;
  isPaused: boolean;
  isMobile: boolean;
}>();

let visibilityListenerInitialized = false;
let globalTimerIdCounter = 0;

// Detect mobile device
function isMobile(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent.toLowerCase();
  const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent);
  const isSmallScreen = window.innerWidth <= 768;
  return isMobileUA || isSmallScreen;
}

// Initialize global visibility change listener
function initVisibilityListener(): void {
  if (typeof document === 'undefined' || visibilityListenerInitialized) return;

  visibilityListenerInitialized = true;

  document.addEventListener('visibilitychange', () => {
    const isVisible = document.visibilityState === 'visible';

    managedTimers.forEach((timer) => {
      if (timer.options.pauseWhenHidden !== false) {
        if (isVisible) {
          // Resume timer
          if (timer.isPaused && !timer.intervalId) {
            const effectiveInterval = timer.isMobile
              ? timer.options.interval * (timer.options.mobileMultiplier ?? 2)
              : timer.options.interval;

            // Optionally run immediately when becoming visible
            if (timer.options.runImmediatelyOnVisible) {
              try {
                timer.callback();
              } catch (e) {
                console.error('Timer callback error on visibility change:', e);
              }
            }

            timer.intervalId = setInterval(() => {
              try {
                timer.callback();
              } catch (e) {
                console.error('Timer callback error:', e);
              }
            }, effectiveInterval);
            timer.isPaused = false;
          }
        } else {
          // Pause timer
          if (timer.intervalId) {
            clearInterval(timer.intervalId);
            timer.intervalId = null;
            timer.isPaused = true;
          }
        }
      }
    });
  });

  // Also handle page freeze/resume events for aggressive battery saving
  if ('onfreeze' in document) {
    document.addEventListener('freeze', () => {
      managedTimers.forEach((timer) => {
        if (timer.intervalId) {
          clearInterval(timer.intervalId);
          timer.intervalId = null;
          timer.isPaused = true;
        }
      });
    });

    document.addEventListener('resume', () => {
      managedTimers.forEach((timer) => {
        if (timer.isPaused && timer.options.pauseWhenHidden !== false) {
          const effectiveInterval = timer.isMobile
            ? timer.options.interval * (timer.options.mobileMultiplier ?? 2)
            : timer.options.interval;

          timer.intervalId = setInterval(() => {
            try {
              timer.callback();
            } catch (e) {
              console.error('Timer callback error:', e);
            }
          }, effectiveInterval);
          timer.isPaused = false;
        }
      });
    });
  }
}

/**
 * Creates a visibility-aware interval timer that pauses when the app is backgrounded.
 *
 * @example
 * const timer = createVisibilityAwareInterval(
 *   () => console.log('Tick'),
 *   { interval: 30000, mobileMultiplier: 2 }
 * );
 *
 * // Later: timer.stop() to permanently stop
 */
export function createVisibilityAwareInterval(
  callback: TimerCallback,
  options: TimerOptions
): ManagedTimer {
  initVisibilityListener();

  const id = `timer_${++globalTimerIdCounter}`;
  const mobile = isMobile();
  const effectiveInterval = mobile
    ? options.interval * (options.mobileMultiplier ?? 2)
    : options.interval;

  // Start the timer
  const intervalId = setInterval(() => {
    try {
      callback();
    } catch (e) {
      console.error('Timer callback error:', e);
    }
  }, effectiveInterval);

  const timerState: {
    callback: TimerCallback;
    options: TimerOptions;
    intervalId: ReturnType<typeof setInterval> | null;
    isPaused: boolean;
    isMobile: boolean;
  } = {
    callback,
    options,
    intervalId,
    isPaused: false,
    isMobile: mobile,
  };

  managedTimers.set(id, timerState);

  return {
    id,
    stop: () => {
      if (timerState.intervalId) {
        clearInterval(timerState.intervalId);
        timerState.intervalId = null;
      }
      managedTimers.delete(id);
    },
    pause: () => {
      if (timerState.intervalId) {
        clearInterval(timerState.intervalId);
        timerState.intervalId = null;
        timerState.isPaused = true;
      }
    },
    resume: () => {
      if (timerState.isPaused && !timerState.intervalId) {
        timerState.intervalId = setInterval(() => {
          try {
            callback();
          } catch (e) {
            console.error('Timer callback error:', e);
          }
        }, effectiveInterval);
        timerState.isPaused = false;
      }
    },
    isRunning: () => timerState.intervalId !== null && !timerState.isPaused,
  };
}

/**
 * Creates a one-time delayed callback that won't fire if the page is hidden.
 * If the page becomes visible before the delay, it will fire after the remaining time.
 */
export function createVisibilityAwareTimeout(
  callback: TimerCallback,
  delay: number
): { cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let remainingTime = delay;
  let startTime = Date.now();
  let cancelled = false;

  const execute = () => {
    if (cancelled) return;
    try {
      callback();
    } catch (e) {
      console.error('Timeout callback error:', e);
    }
  };

  const start = () => {
    if (cancelled) return;
    startTime = Date.now();
    timeoutId = setTimeout(execute, remainingTime);
  };

  const pause = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
      remainingTime -= Date.now() - startTime;
      if (remainingTime < 0) remainingTime = 0;
    }
  };

  // Start immediately if visible
  if (typeof document === 'undefined' || document.visibilityState === 'visible') {
    start();
  }

  const handleVisibility = () => {
    if (cancelled) return;
    if (document.visibilityState === 'visible') {
      start();
    } else {
      pause();
    }
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibility);
  }

  return {
    cancel: () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    },
  };
}

/**
 * Utility to check if we should run expensive operations
 * Returns false if on mobile with low battery
 */
export async function shouldRunExpensiveOperation(): Promise<boolean> {
  if (typeof navigator === 'undefined') return true;

  // Check if page is visible
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
    return false;
  }

  // Check battery level on mobile
  if ('getBattery' in navigator) {
    try {
      const battery = await (navigator as unknown as { getBattery: () => Promise<{ level: number; charging: boolean }> }).getBattery();
      const batteryLevel = battery.level * 100;

      // Skip expensive operations if battery is low and not charging
      if (!battery.charging && batteryLevel < 20) {
        return false;
      }
    } catch {
      // Battery API not available, continue anyway
    }
  }

  return true;
}

/**
 * Get the count of active timers (for debugging)
 */
export function getActiveTimerCount(): number {
  return managedTimers.size;
}

/**
 * Stop all managed timers (cleanup on unmount)
 */
export function stopAllTimers(): void {
  managedTimers.forEach((timer, id) => {
    if (timer.intervalId) {
      clearInterval(timer.intervalId);
    }
    managedTimers.delete(id);
  });
}
