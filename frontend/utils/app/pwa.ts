// PWA Registration and utilities
import { createVisibilityAwareInterval } from './visibilityAwareTimer';

let onUpdateAvailable: (() => void) | null = null;

export const setOnUpdateAvailable = (callback: () => void) => {
  onUpdateAvailable = callback;
};

export const registerServiceWorker = async () => {
  // Register on all environments including localhost for testing
  if ('serviceWorker' in navigator && typeof window !== 'undefined') {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
      });

      console.log('Service Worker registered successfully:', registration);

      // Check for updates periodically - visibility-aware to save battery
      // Only check when app is visible, uses longer interval on mobile
      createVisibilityAwareInterval(
        () => {
          registration.update();
        },
        {
          interval: 2 * 60 * 60 * 1000, // Check every 2 hours (increased from 1 hour)
          mobileMultiplier: 2, // 4 hours on mobile
          pauseWhenHidden: true, // Don't check when app is backgrounded
          runImmediatelyOnVisible: false,
        },
      );

      // Handle updates
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (
              newWorker.state === 'activated' &&
              navigator.serviceWorker.controller
            ) {
              // New service worker activated, notify via callback
              onUpdateAvailable?.();
            }
          });
        }
      });

      return registration;
    } catch (error) {
      console.error('Service Worker registration failed:', error);
    }
  }
};

// Names of current or legacy Cache Storage buckets that may hold user-private
// data. Keep the legacy conversation bucket until all old workers have aged
// out; the current service worker never caches authenticated API responses.
const PRIVATE_CACHE_NAMES = ['daedalus-conversations-v1', 'daedalus-runtime'];

/**
 * Drop caches that may contain user-private data (conversation history /
 * per-conversation responses, runtime-cached HTML). Call on login and logout so
 * a previous user's offline-cached data cannot be served to the next user on a
 * shared device. Callers await this before switching authenticated identity.
 */
export const clearPrivateCaches = async (): Promise<void> => {
  if (typeof window === 'undefined') return;

  // 1) Delete the caches directly from the page. The page shares Cache Storage
  //    with the service worker, and this works regardless of which SW version
  //    controls the page — critical right after a deploy, when a returning user
  //    is still controlled by the OLD worker that has no CLEAR_PRIVATE_CACHES
  //    handler and would silently drop the message below.
  if ('caches' in window) {
    await Promise.all(
      PRIVATE_CACHE_NAMES.map((name) => window.caches.delete(name)),
    ).catch((error) => {
      console.error('Failed to clear private caches from page:', error);
    });
  }

  // 2) Also notify the service worker so it resets its in-memory LRU accounting
  //    (and any future SW-side cleanup) when one is controlling the page.
  if ('serviceWorker' in navigator) {
    try {
      const controller = navigator.serviceWorker.controller;
      if (controller) {
        controller.postMessage({ type: 'CLEAR_PRIVATE_CACHES' });
      } else {
        const registration = await navigator.serviceWorker.getRegistration();
        registration?.active?.postMessage({ type: 'CLEAR_PRIVATE_CACHES' });
      }
    } catch (error) {
      console.error('Failed to request private cache clear:', error);
    }
  }
};

export const setupOfflineDetection = (
  onOffline?: () => void,
  onOnline?: () => void,
) => {
  window.addEventListener('offline', () => {
    console.log('App is offline');
    onOffline?.();
  });

  window.addEventListener('online', () => {
    console.log('App is back online');
    onOnline?.();
  });
};
