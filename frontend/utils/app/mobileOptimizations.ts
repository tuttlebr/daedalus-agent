// Mobile device detection and adaptive memory optimization utilities

export interface DeviceCapabilities {
  isMobile: boolean;
  isLowMemoryDevice: boolean;
  memoryLimitMB: number;
  recommendedImageQuality: number;
  recommendedCacheSizeMB: number;
  recommendedMaxMessages: number;
  enableBackgroundProcessing: boolean;
  enableIntermediateSteps: boolean;
  enableRichMedia: boolean;
}

interface MemoryProfile {
  low: { threshold: number; settings: Partial<DeviceCapabilities> };
  medium: { threshold: number; settings: Partial<DeviceCapabilities> };
  high: { threshold: number; settings: Partial<DeviceCapabilities> };
}

// Detect mobile device
export function isMobile(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;

  // Check multiple indicators
  const userAgent = navigator.userAgent.toLowerCase();
  const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent);
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isSmallScreen = window.innerWidth <= 768;
  const hasCoarsePointer = window.matchMedia('(pointer: coarse)').matches;

  return isMobileUA || (isTouchDevice && (isSmallScreen || hasCoarsePointer));
}

// Detect if device has limited memory
export async function detectMemoryConstraints(): Promise<{
  totalMemory: number;
  isLowMemory: boolean;
}> {
  // Default values for browsers without memory info
  let totalMemory = 4096; // Default 4GB
  let isLowMemory = false;

  if (typeof navigator !== 'undefined' && 'deviceMemory' in navigator) {
    // deviceMemory returns RAM in GB
    totalMemory = (navigator as any).deviceMemory * 1024;
    isLowMemory = totalMemory <= 2048; // 2GB or less
  } else if (typeof performance !== 'undefined' && (performance as any).memory) {
    // Chrome-specific API (in MB)
    const memInfo = (performance as any).memory;
    if (memInfo.jsHeapSizeLimit) {
      // Estimate total memory from heap limit
      totalMemory = Math.floor(memInfo.jsHeapSizeLimit / (1024 * 1024) * 4);
      isLowMemory = totalMemory <= 2048;
    }
  } else if (isMobile()) {
    // Conservative estimate for mobile devices
    totalMemory = 2048;
    isLowMemory = true;
  }

  return { totalMemory, isLowMemory };
}

// Get optimized settings based on device capabilities
export async function getDeviceOptimizedSettings(): Promise<DeviceCapabilities> {
  const mobile = isMobile();
  const { totalMemory, isLowMemory } = await detectMemoryConstraints();

  // Memory profiles for different device capabilities
  const memoryProfiles: MemoryProfile = {
    low: {
      threshold: 2048,
      settings: {
        recommendedImageQuality: 0.5,
        recommendedCacheSizeMB: 5,
        recommendedMaxMessages: 30,
        enableBackgroundProcessing: false,
        enableIntermediateSteps: false,
        enableRichMedia: false
      }
    },
    medium: {
      threshold: 4096,
      settings: {
        recommendedImageQuality: 0.7,
        recommendedCacheSizeMB: 15,
        recommendedMaxMessages: 50,
        enableBackgroundProcessing: true,
        enableIntermediateSteps: true,
        enableRichMedia: true
      }
    },
    high: {
      threshold: Infinity,
      settings: {
        recommendedImageQuality: 0.9,
        recommendedCacheSizeMB: 30,
        recommendedMaxMessages: 100,
        enableBackgroundProcessing: true,
        enableIntermediateSteps: true,
        enableRichMedia: true
      }
    }
  };

  // Determine profile based on memory
  let profile = memoryProfiles.high.settings;
  if (totalMemory <= memoryProfiles.low.threshold) {
    profile = memoryProfiles.low.settings;
  } else if (totalMemory <= memoryProfiles.medium.threshold) {
    profile = memoryProfiles.medium.settings;
  }

  // Apply mobile-specific adjustments
  if (mobile) {
    profile.recommendedCacheSizeMB = Math.floor((profile.recommendedCacheSizeMB || 30) * 0.6);
    profile.recommendedMaxMessages = Math.floor((profile.recommendedMaxMessages || 100) * 0.7);
    profile.recommendedImageQuality = Math.min(0.7, profile.recommendedImageQuality || 1);
  }

  return {
    isMobile: mobile,
    isLowMemoryDevice: isLowMemory,
    memoryLimitMB: totalMemory,
    recommendedImageQuality: profile.recommendedImageQuality || 0.9,
    recommendedCacheSizeMB: profile.recommendedCacheSizeMB || 30,
    recommendedMaxMessages: profile.recommendedMaxMessages || 100,
    enableBackgroundProcessing: profile.enableBackgroundProcessing ?? true,
    enableIntermediateSteps: profile.enableIntermediateSteps ?? true,
    enableRichMedia: profile.enableRichMedia ?? true
  };
}

// Import visibility-aware timer for battery-efficient monitoring
interface ManagedTimer {
  stop: () => void;
  pause: () => void;
  resume: () => void;
  isRunning: () => boolean;
}

let visibilityTimerModule: { createVisibilityAwareInterval: (cb: () => void | Promise<void>, opts: { interval: number; mobileMultiplier?: number; pauseWhenHidden?: boolean }) => ManagedTimer } | null = null;

// Monitor memory pressure and adjust settings dynamically
export class AdaptiveMemoryManager {
  private currentSettings: DeviceCapabilities;
  private memoryCheckTimer: ManagedTimer | null = null;
  private onSettingsChange?: (settings: DeviceCapabilities) => void;

  constructor(onSettingsChange?: (settings: DeviceCapabilities) => void) {
    this.onSettingsChange = onSettingsChange;
    this.currentSettings = {
      isMobile: false,
      isLowMemoryDevice: false,
      memoryLimitMB: 4096,
      recommendedImageQuality: 0.9,
      recommendedCacheSizeMB: 30,
      recommendedMaxMessages: 100,
      enableBackgroundProcessing: true,
      enableIntermediateSteps: true,
      enableRichMedia: true
    };
  }

  async initialize() {
    this.currentSettings = await getDeviceOptimizedSettings();
    this.onSettingsChange?.(this.currentSettings);

    // Load visibility-aware timer module
    if (typeof window !== 'undefined') {
      visibilityTimerModule = await import('./visibilityAwareTimer');
    }

    // Start monitoring if on mobile or low memory device
    if (this.currentSettings.isMobile || this.currentSettings.isLowMemoryDevice) {
      this.startMonitoring();
    }
  }

  private startMonitoring() {
    if (!visibilityTimerModule) {
      console.warn('Visibility timer module not loaded, skipping memory monitoring');
      return;
    }

    // Use visibility-aware timer - pauses when app is hidden to save battery
    // Check every 30s on desktop, 60s on mobile
    this.memoryCheckTimer = visibilityTimerModule.createVisibilityAwareInterval(
      async () => {
        if (typeof performance !== 'undefined' && (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory) {
          const memInfo = (performance as unknown as { memory: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
          const percentUsed = (memInfo.usedJSHeapSize / memInfo.jsHeapSizeLimit) * 100;

          // Dynamically adjust settings based on memory pressure
          if (percentUsed > 80 && this.currentSettings.enableRichMedia) {
            this.currentSettings.enableRichMedia = false;
            this.currentSettings.enableIntermediateSteps = false;
            this.currentSettings.recommendedImageQuality = 0.3;
            this.onSettingsChange?.(this.currentSettings);
          } else if (percentUsed > 70 && this.currentSettings.enableIntermediateSteps) {
            this.currentSettings.enableIntermediateSteps = false;
            this.currentSettings.recommendedImageQuality = 0.5;
            this.onSettingsChange?.(this.currentSettings);
          } else if (percentUsed < 60 && !this.currentSettings.enableIntermediateSteps) {
            // Re-enable features when memory pressure is low
            const baseSettings = await getDeviceOptimizedSettings();
            this.currentSettings = baseSettings;
            this.onSettingsChange?.(this.currentSettings);
          }
        }
      },
      {
        interval: 30000, // 30 seconds base
        mobileMultiplier: 2, // 60 seconds on mobile
        pauseWhenHidden: true, // Don't monitor when app is backgrounded
      }
    );
  }

  getSettings(): DeviceCapabilities {
    return this.currentSettings;
  }

  stop() {
    if (this.memoryCheckTimer) {
      this.memoryCheckTimer.stop();
      this.memoryCheckTimer = null;
    }
  }
}

// Singleton instance
let adaptiveManager: AdaptiveMemoryManager | null = null;

export function getAdaptiveMemoryManager(onSettingsChange?: (settings: DeviceCapabilities) => void): AdaptiveMemoryManager {
  if (!adaptiveManager) {
    adaptiveManager = new AdaptiveMemoryManager(onSettingsChange);
    adaptiveManager.initialize();
  }
  return adaptiveManager;
}

// Helper to compress images based on device capabilities
export async function adaptiveImageCompress(
  base64Image: string,
  mimeType: string = 'image/jpeg'
): Promise<string> {
  const settings = adaptiveManager?.getSettings() || await getDeviceOptimizedSettings();

  if (!settings.enableRichMedia) {
    // Return placeholder or skip image
    return '';
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(base64Image);
        return;
      }

      // Adaptive sizing based on device
      let maxWidth = settings.isMobile ? 800 : 1200;
      let maxHeight = settings.isMobile ? 800 : 1200;

      if (settings.isLowMemoryDevice) {
        maxWidth = 600;
        maxHeight = 600;
      }

      let width = img.width;
      let height = img.height;

      // Calculate new dimensions
      if (width > maxWidth || height > maxHeight) {
        const ratio = Math.min(maxWidth / width, maxHeight / height);
        width *= ratio;
        height *= ratio;
      }

      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);

      // Convert back to base64 with quality setting
      const compressed = canvas.toDataURL(mimeType, settings.recommendedImageQuality);
      resolve(compressed);
    };

    img.onerror = () => resolve(base64Image);
    img.src = base64Image;
  });
}

// Export utility functions
export const mobileUtils = {
  isMobile,
  detectMemoryConstraints,
  getDeviceOptimizedSettings,
  adaptiveImageCompress
};
