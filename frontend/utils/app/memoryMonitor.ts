import { getAdaptiveMemoryManager, DeviceCapabilities } from './mobileOptimizations';

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

class MemoryMonitor {
  private config: MemoryMonitorConfig;
  private intervalId: NodeJS.Timeout | null = null;
  private lastState: 'normal' | 'warning' | 'critical' = 'normal';
  private measurements: MemoryInfo[] = [];
  private maxMeasurements = 100;

  constructor(config: Partial<MemoryMonitorConfig> = {}) {
    this.config = {
      warningThreshold: 80,
      criticalThreshold: 90,
      checkInterval: 5000, // Check every 5 seconds
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
      }
    });
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
      console.error(`🚨 CRITICAL: Memory usage at ${info.percentUsed.toFixed(1)}%`, {
        used: this.formatBytes(info.usedJSHeapSize),
        limit: this.formatBytes(info.jsHeapSizeLimit)
      });

      if (this.config.onCritical) {
        this.config.onCritical(info);
      }
    } else if (info.percentUsed >= this.config.warningThreshold) {
      currentState = 'warning';
      console.warn(`⚠️ WARNING: Memory usage at ${info.percentUsed.toFixed(1)}%`, {
        used: this.formatBytes(info.usedJSHeapSize),
        limit: this.formatBytes(info.jsHeapSizeLimit)
      });

      if (this.config.onWarning) {
        this.config.onWarning(info);
      }
    } else {
      // Only log and callback when transitioning back to normal
      if (this.lastState !== 'normal') {
        console.log(`✅ Memory usage normal: ${info.percentUsed.toFixed(1)}%`);
        if (this.config.onNormal) {
          this.config.onNormal(info);
        }
      }
    }

    this.lastState = currentState;
  }

  start(): void {
    if (this.intervalId) return;

    // Check if we can monitor memory
    if (!('memory' in performance)) {
      console.warn('Memory monitoring not available in this browser');
      return;
    }

    // Initial check
    this.checkMemory();

    // Set up interval
    this.intervalId = setInterval(() => {
      this.checkMemory();
    }, this.config.checkInterval);

    console.log('Memory monitoring started');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('Memory monitoring stopped');
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
      console.log('Forcing garbage collection...');
      (window as any).gc();
    } else {
      console.log('Manual garbage collection not available');
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
    const monitor = new MemoryMonitor({
      ...config,
      onWarning: (info) => {
        setMemoryInfo(info);
        setIsHighMemory(true);
        config?.onWarning?.(info);
      },
      onCritical: (info) => {
        setMemoryInfo(info);
        setIsHighMemory(true);
        config?.onCritical?.(info);
      },
      onNormal: (info) => {
        setMemoryInfo(info);
        setIsHighMemory(false);
        config?.onNormal?.(info);
      }
    });

    monitor.start();

    return () => {
      monitor.stop();
    };
  }, []);

  return { memoryInfo, isHighMemory };
}

// Import React for the hook
import React from 'react';
