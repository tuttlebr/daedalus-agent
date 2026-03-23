import { useEffect, useRef, useCallback, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '@/utils/logger';
import { createVisibilityAwareInterval, type ManagedTimer } from '@/utils/app/visibilityAwareTimer';

const logger = new Logger('SessionRegistry');

export interface DeviceInfo {
  userAgent?: string;
  platform?: string;
  screenWidth?: number;
  screenHeight?: number;
  isMobile?: boolean;
}

export interface UseSessionRegistryOptions {
  enabled?: boolean;
  heartbeatInterval?: number; // Default 60 seconds
}

export interface UseSessionRegistryReturn {
  sessionId: string;
  isRegistered: boolean;
}

const HEARTBEAT_INTERVAL = 60000; // 60 seconds

export const useSessionRegistry = (options: UseSessionRegistryOptions = {}): UseSessionRegistryReturn => {
  const { enabled = true, heartbeatInterval = HEARTBEAT_INTERVAL } = options;

  const [sessionId] = useState(() => {
    if (typeof window === 'undefined') return '';
    // Try to get existing session ID from storage, or create new one
    const stored = sessionStorage.getItem('daedalus_session_id');
    if (stored) return stored;
    const newId = uuidv4();
    sessionStorage.setItem('daedalus_session_id', newId);
    return newId;
  });

  const [isRegistered, setIsRegistered] = useState(false);
  const heartbeatTimerRef = useRef<ManagedTimer | null>(null);
  const isUnmountingRef = useRef(false);

  const getDeviceInfo = useCallback((): DeviceInfo => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return {};
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      isMobile: /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
        navigator.userAgent.toLowerCase()
      ),
    };
  }, []);

  const registerSession = useCallback(async () => {
    if (!enabled || !sessionId) return;

    try {
      const response = await fetch('/api/session/registry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          deviceInfo: getDeviceInfo(),
        }),
      });

      if (response.ok) {
        setIsRegistered(true);
        logger.info('Session registered', { sessionId });
      }
    } catch (error) {
      logger.error('Failed to register session', error);
    }
  }, [enabled, sessionId, getDeviceInfo]);

  const sendHeartbeat = useCallback(async () => {
    if (!enabled || !sessionId || isUnmountingRef.current) return;

    try {
      const response = await fetch('/api/session/registry', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          deviceInfo: getDeviceInfo(),
        }),
      });

      if (!response.ok) {
        logger.warn('Heartbeat failed, re-registering');
        await registerSession();
      }
    } catch (error) {
      logger.error('Failed to send heartbeat', error);
    }
  }, [enabled, sessionId, getDeviceInfo, registerSession]);

  const unregisterSession = useCallback(async () => {
    if (!sessionId) return;

    try {
      // Use sendBeacon for reliable unregister on page close
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        navigator.sendBeacon(
          `/api/session/registry?sessionId=${sessionId}`,
          JSON.stringify({ _method: 'DELETE' })
        );
      } else {
        // Fallback to fetch with keepalive
        fetch(`/api/session/registry?sessionId=${sessionId}`, {
          method: 'DELETE',
          keepalive: true,
        }).catch(() => {});
      }
      logger.info('Session unregistered', { sessionId });
    } catch (error) {
      logger.error('Failed to unregister session', error);
    }
  }, [sessionId]);

  // Register on mount
  useEffect(() => {
    if (!enabled) return;

    registerSession();

    // Start visibility-aware heartbeat timer
    // This pauses when app is backgrounded, saving battery on mobile
    heartbeatTimerRef.current = createVisibilityAwareInterval(sendHeartbeat, {
      interval: heartbeatInterval,
      pauseWhenHidden: true,
      mobileMultiplier: 2, // Double interval on mobile for battery savings
      runImmediatelyOnVisible: true, // Send heartbeat when returning to foreground
    });

    return () => {
      isUnmountingRef.current = true;
      if (heartbeatTimerRef.current) {
        heartbeatTimerRef.current.stop();
        heartbeatTimerRef.current = null;
      }
    };
  }, [enabled, registerSession, sendHeartbeat, heartbeatInterval]);

  // Unregister on page unload
  useEffect(() => {
    if (!enabled) return;

    const handleUnload = () => {
      unregisterSession();
    };

    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);

    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      window.removeEventListener('pagehide', handleUnload);
    };
  }, [enabled, unregisterSession]);

  // Handle visibility changes - the visibility-aware timer handles pause/resume,
  // so we only need to check if we need to re-register (stale session detection)
  useEffect(() => {
    if (!enabled) return;

    const handleVisibilityChange = () => {
      // Only re-register if session might have expired during background
      // The visibility-aware timer already handles sending heartbeat on return
      if (document.visibilityState === 'visible' && !isRegistered) {
        registerSession();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [enabled, isRegistered, registerSession]);

  return {
    sessionId,
    isRegistered,
  };
};
