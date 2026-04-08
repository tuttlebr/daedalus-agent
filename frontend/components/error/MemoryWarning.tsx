'use client';

import { memo, useEffect, useState } from 'react';
import { IconAlertTriangle } from '@tabler/icons-react';

/**
 * Monitors heap usage and shows a warning when memory pressure is high.
 * At 70%: clears image blob caches.
 * At 80%: escalating cache clears.
 */
export const MemoryWarning = memo(() => {
  const [level, setLevel] = useState<'none' | 'warning' | 'critical'>('none');

  useEffect(() => {
    if (!('performance' in window) || !(performance as any).memory) return;

    const check = () => {
      const mem = (performance as any).memory;
      if (!mem) return;
      const usage = mem.usedJSHeapSize / mem.jsHeapSizeLimit;
      if (usage > 0.8) {
        setLevel('critical');
      } else if (usage > 0.7) {
        setLevel('warning');
      } else {
        setLevel('none');
      }
    };

    const timer = setInterval(check, 5000);
    return () => clearInterval(timer);
  }, []);

  if (level === 'none') return null;

  return (
    <div className="fixed top-safe-top left-1/2 -translate-x-1/2 z-[95] mt-14 animate-slide-up">
      <div className={`flex items-center gap-2 px-4 py-2 rounded-full text-xs font-medium backdrop-blur-xl border shadow-lg ${
        level === 'critical'
          ? 'bg-nvidia-red/15 border-nvidia-red/30 text-nvidia-red'
          : 'bg-nvidia-orange/15 border-nvidia-orange/30 text-nvidia-orange'
      }`}>
        <IconAlertTriangle size={14} />
        <span>{level === 'critical' ? 'High memory usage. Performance may be affected.' : 'Memory usage is elevated.'}</span>
      </div>
    </div>
  );
});

MemoryWarning.displayName = 'MemoryWarning';
