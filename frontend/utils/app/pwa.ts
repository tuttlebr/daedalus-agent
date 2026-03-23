// PWA Registration and utilities
import { createVisibilityAwareInterval } from './visibilityAwareTimer';

export let onUpdateAvailable: (() => void) | null = null;

export const setOnUpdateAvailable = (callback: () => void) => {
  onUpdateAvailable = callback;
};

export const registerServiceWorker = async () => {
  // Register on all environments including localhost for testing
  if ('serviceWorker' in navigator && typeof window !== 'undefined') {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/'
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
          mobileMultiplier: 2,          // 4 hours on mobile
          pauseWhenHidden: true,        // Don't check when app is backgrounded
          runImmediatelyOnVisible: false,
        }
      );

      // Handle updates
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
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

export const requestNotificationPermission = async () => {
  if ('Notification' in window && 'serviceWorker' in navigator) {
    const permission = await Notification.requestPermission();
    return permission === 'granted';
  }
  return false;
};

export const checkOnlineStatus = () => {
  return navigator.onLine;
};

export const setupOfflineDetection = (onOffline?: () => void, onOnline?: () => void) => {
  window.addEventListener('offline', () => {
    console.log('App is offline');
    onOffline?.();
  });

  window.addEventListener('online', () => {
    console.log('App is back online');
    onOnline?.();
  });
};

// Install prompt handling for A2HS (Add to Home Screen)
let deferredPrompt: any;

export const setupInstallPrompt = () => {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    // Show custom install button
    return false;
  });
};

export const showInstallPrompt = async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log(`User response to install prompt: ${outcome}`);
    deferredPrompt = null;
    return outcome === 'accepted';
  }
  return false;
};

export const isPWAInstalled = () => {
  return window.matchMedia('(display-mode: standalone)').matches ||
         (window.navigator as any).standalone === true;
};

/**
 * Subscribe to push notifications using the VAPID public key.
 * Sends the subscription to the server for storage.
 */
export const subscribeToPush = async (): Promise<boolean> => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;

  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidKey) return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing) return true; // Already subscribed

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });

    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(subscription.toJSON()),
    });

    return true;
  } catch (error) {
    console.error('Push subscription failed:', error);
    return false;
  }
};

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
