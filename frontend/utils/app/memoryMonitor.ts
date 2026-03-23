import { getAdaptiveMemoryManager, DeviceCapabilities } from './mobileOptimizations';
import { Logger } from '../logger';
import { createVisibilityAwareInterval } from './visibilityAwareTimer';

const logger = new Logger('MemoryMonitor');

interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
  percentUsed: number;
  timestamp: number;
}

interface MemoryMonitorConfig {
  warningThreshold: number; // Percentage (e.g., 80)
  criticalThreshold: number; // Percentage (e.g., 90)
  checkInterval: number; // Milliseconds
  onWarning?: (info: MemoryInfo) => void;
  onCritical?: (info: MemoryInfo) => void;
  onNormal?: (info: MemoryInfo) => void;
}

type MemoryListener = (info: MemoryInfo, state: 'normal' | 'warning' | 'critical') => void;

interface ManagedTimer {
  stop: () => void;
  pause: () => void;
  resume: () => void;
  isRunning: () => boolean;
}

class MemoryMonitor {
  private config: MemoryMonitorConfig;
  private visibilityAwareTimer: ManagedTimer | null = null;
  private lastState: 'normal' | 'warning' | 'critical' = 'normal';
  private measurements: MemoryInfo[] = [];
  private maxMeasurements = 100;
  private listeners: Set<MemoryListener> = new Set();

  constructor(config: Partial<MemoryMonitorConfig> = {}) {
    this.config = {
      warningThreshold: 80,
      criticalThreshold: 90,
      checkInterval: 60000, // Check every 60 seconds (increased from 30s for battery)
      ...config
    };

    // Adjust thresholds based on device capabilities
    getAdaptiveMemoryManager((settings: DeviceCapabilities) => {
      if (settings.isLowMemoryDevice) {
        this.config.warningThreshold = 60;
        this.config.criticalThreshold = 70;
      } else if (settings.isMobile) {
        this.config.warningThreshold = 70;
        this.config.criticalThreshold = 80;
        // Use longer check interval on mobile to save battery
        this.config.checkInterval = 90000; // 90 seconds
      }
    });
  }

  addListener(listener: MemoryListener) {
    this.listeners.add(listener);
  }

  removeListener(listener: MemoryListener) {
    this.listeners.delete(listener);
  }

  private getMemoryInfo(): MemoryInfo | null {
    // Check if performance.memory is available (Chrome/Edge only)
    if ('memory' in performance) {
      const memory = (performance as any).memory;
      const percentUsed = (memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100;

      return {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
        percentUsed,
        timestamp: Date.now()
      };
    }

    return null;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private checkMemory(): void {
    const info = this.getMemoryInfo();
    if (!info) return;

    // Store measurement
    this.measurements.push(info);
    if (this.measurements.length > this.maxMeasurements) {
      this.measurements.shift();
    }

    let currentState: 'normal' | 'warning' | 'critical' = 'normal';

    if (info.percentUsed >= this.config.criticalThreshold) {
      currentState = 'critical';
      logger.error(`Memory usage critical at ${info.percentUsed.toFixed(1)}%`, {
        used: this.formatBytes(info.usedJSHeapSize),
        limit: this.formatBytes(info.jsHeapSizeLimit)
      });

      if (this.config.onCritical) {
        this.config.onCritical(info);
      }
    } else if (info.percentUsed >= this.config.warningThreshold) {
      currentState = 'warning';
      logger.warn(`Memory usage high at ${info.percentUsed.toFixed(1)}%`, {
        used: this.formatBytes(info.usedJSHeapSize),
        limit: this.formatBytes(info.jsHeapSizeLimit)
      });

      if (this.config.onWarning) {
        this.config.onWarning(info);
      }
    } else {
      // Only log and callback when transitioning back to normal
      if (this.lastState !== 'normal') {
        logger.info(`Memory usage normal: ${info.percentUsed.toFixed(1)}%`);
        if (this.config.onNormal) {
          this.config.onNormal(info);
        }
      }
    }

    this.lastState = currentState;
    this.listeners.forEach(listener => listener(info, currentState));
  }

  start(): void {
    if (this.visibilityAwareTimer) return;

    // Check if we can monitor memory
    if (!('memory' in performance)) {
      logger.warn('Memory monitoring not available in this browser');
      return;
    }

    // Initial check
    this.checkMemory();

    // Set up visibility-aware interval - pauses when app is hidden to save battery
    this.visibilityAwareTimer = createVisibilityAwareInterval(
      () => this.checkMemory(),
      {
        interval: this.config.checkInterval,
        mobileMultiplier: 1.5, // Even slower on mobile
        pauseWhenHidden: true, // Don't check memory when app is backgrounded
      }
    );

    logger.info('Memory monitoring started (visibility-aware)');
  }

  stop(): void {
    if (this.visibilityAwareTimer) {
      this.visibilityAwareTimer.stop();
      this.visibilityAwareTimer = null;
      logger.info('Memory monitoring stopped');
    }
  }

  getStats(): {
    current: MemoryInfo | null;
    average: number;
    max: number;
    trend: 'increasing' | 'decreasing' | 'stable';
  } {
    const current = this.getMemoryInfo();

    if (this.measurements.length === 0) {
      return {
        current,
        average: current?.percentUsed || 0,
        max: current?.percentUsed || 0,
        trend: 'stable'
      };
    }

    const percentages = this.measurements.map(m => m.percentUsed);
    const average = percentages.reduce((a, b) => a + b, 0) / percentages.length;
    const max = Math.max(...percentages);

    // Calculate trend
    let trend: 'increasing' | 'decreasing' | 'stable' = 'stable';
    if (this.measurements.length >= 5) {
      const recent = this.measurements.slice(-5);
      const firstHalf = recent.slice(0, 2).map(m => m.percentUsed);
      const secondHalf = recent.slice(-2).map(m => m.percentUsed);

      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

      if (secondAvg > firstAvg + 5) {
        trend = 'increasing';
      } else if (secondAvg < firstAvg - 5) {
        trend = 'decreasing';
      }
    }

    return { current, average, max, trend };
  }

  forceGarbageCollection(): void {
    // Try to force garbage collection (only works in some environments)
    if ('gc' in window) {
      logger.info('Forcing garbage collection...');
      (window as any).gc();
    } else {
      logger.info('Manual garbage collection not available');
    }
  }
}

// Export singleton instance
export const memoryMonitor = new MemoryMonitor();

// Helper functions for easy usage
export function startMemoryMonitoring(config?: Partial<MemoryMonitorConfig>): void {
  if (config) {
    Object.assign(memoryMonitor, { config: { ...memoryMonitor['config'], ...config } });
  }
  memoryMonitor.start();
}

export function stopMemoryMonitoring(): void {
  memoryMonitor.stop();
}

export function getMemoryStats() {
  return memoryMonitor.getStats();
}

export function checkMemoryPressure(): boolean {
  const stats = memoryMonitor.getStats();
  return stats.current ? stats.current.percentUsed > 80 : false;
}

// React hook for memory monitoring
export function useMemoryMonitor(config?: Partial<MemoryMonitorConfig>) {
  const [memoryInfo, setMemoryInfo] = React.useState<MemoryInfo | null>(null);
  const [isHighMemory, setIsHighMemory] = React.useState(false);

  React.useEffect(() => {
    // Update global config if provided
    if (config) {
       // Note: This updates the global singleton config which might affect other components
       // For a strictly local monitor, we would need a separate instance, but the goal is efficiency
       startMemoryMonitoring(config);
    } else {
       memoryMonitor.start();
    }

    const listener: MemoryListener = (info, state) => {
       setMemoryInfo(info);
       setIsHighMemory(state !== 'normal');

       if (state === 'warning') config?.onWarning?.(info);
       if (state === 'critical') config?.onCritical?.(info);
       if (state === 'normal') config?.onNormal?.(info);
    };

    memoryMonitor.addListener(listener);

    return () => {
      memoryMonitor.removeListener(listener);
      // Don't stop the global monitor here as other components might rely on it
    };
  }, [config]); // Re-subscribe if config changes

  return { memoryInfo, isHighMemory };
}

// Import React for the hook
import React from 'react';
