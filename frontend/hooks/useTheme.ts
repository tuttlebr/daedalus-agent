import { useEffect } from 'react';
import { useUISettingsStore, useLightMode } from '@/state';

/**
 * Hook that syncs the Zustand theme state with the document's `dark` class
 * and system preference. Returns the current mode and a toggle function.
 *
 * @example
 * const { mode, toggle, setMode } = useTheme();
 */
export function useTheme() {
  const mode = useLightMode();
  const setLightMode = useUISettingsStore((s) => s.setLightMode);
  const toggleLightMode = useUISettingsStore((s) => s.toggleLightMode);

  // Sync dark class on <html> whenever mode changes
  useEffect(() => {
    const root = document.documentElement;
    if (mode === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [mode]);

  return {
    mode,
    isDark: mode === 'dark',
    toggle: toggleLightMode,
    setMode: setLightMode,
  };
}
