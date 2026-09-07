import { useEffect, useState } from 'react';

import { useUISettingsStore } from '@/state';

/** Resolve the saved appearance, and keep System in sync while the app is open. */
export function useTheme() {
  const mode = useUISettingsStore((s) => s.lightMode);
  const setMode = useUISettingsStore((s) => s.setLightMode);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      const dark = mode === 'dark' || (mode === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
      setIsDark(dark);
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [mode]);

  return {
    mode,
    isDark,
    setMode,
    toggle: () => setMode(isDark ? 'light' : 'dark'),
  };
}
