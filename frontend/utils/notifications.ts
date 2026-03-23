// Notification utilities for PWA background processing

export interface NotificationOptions {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  requireInteraction?: boolean;
}

// Request notification permission
export const requestNotificationPermission = async (): Promise<NotificationPermission> => {
  if (!('Notification' in window)) {
    console.warn('Notifications not supported');
    return 'denied';
  }

  if (Notification.permission === 'granted') {
    return 'granted';
  }

  if (Notification.permission !== 'denied') {
    const permission = await Notification.requestPermission();
    return permission;
  }

  return Notification.permission;
};

// Check if the app is currently visible to the user
const isAppVisible = (): boolean => {
  if (typeof document === 'undefined') {
    return true; // Server-side, assume visible
  }
  return document.visibilityState === 'visible';
};

// Show notification (only when app is backgrounded)
export const showNotification = async (options: NotificationOptions, forceShow = false): Promise<void> => {
  // Don't show notifications if user is actively using the app (unless forced)
  if (!forceShow && isAppVisible()) {
    console.log('Skipping notification - user is actively in the app');
    return;
  }

  const permission = await requestNotificationPermission();

  if (permission !== 'granted') {
    console.warn('Notification permission denied');
    return;
  }

  console.log('Sending notification - user is away from app');

  // Check if service worker is available for better notifications
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(options.title, {
        body: options.body,
        icon: options.icon || '/favicon.png',
        badge: options.badge || '/favicon.png',
        tag: options.tag || 'daedalus-notification',
        requireInteraction: options.requireInteraction || false,
        data: {
          dateOfArrival: Date.now(),
        },
      } as any);
    } catch (err) {
      console.error('Service Worker notification failed, falling back:', err);
      // Fallback to regular notification
      new Notification(options.title, {
        body: options.body,
        icon: options.icon || '/favicon.png',
        tag: options.tag,
      });
    }
  } else {
    // Fallback for browsers without service worker
    new Notification(options.title, {
      body: options.body,
      icon: options.icon || '/favicon.png',
      tag: options.tag,
    });
  }
};

// Show streaming completion notification (only if user is away from app)
export const notifyStreamingComplete = async (conversationTitle?: string): Promise<void> => {
  await showNotification({
    title: 'Response Complete',
    body: conversationTitle
      ? `Your AI response in "${conversationTitle}" is ready`
      : 'Your AI response is ready',
    tag: 'streaming-complete',
    requireInteraction: true,
  });
};

// Show streaming interrupted notification (only if user is away from app)
export const notifyStreamingInterrupted = async (): Promise<void> => {
  await showNotification({
    title: 'Streaming Interrupted',
    body: 'Your AI response was interrupted. Return to the app to continue.',
    tag: 'streaming-interrupted',
    requireInteraction: false,
  });
};

// Check if notifications are supported and granted
export const areNotificationsEnabled = (): boolean => {
  return 'Notification' in window && Notification.permission === 'granted';
};
