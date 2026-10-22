import { useEffect, useState } from 'react';

import { useUISettingsStore } from '@/state';

/**
 * Browser chrome, including Safari's web-app title bar, takes the canvas
 * colour so it meets the page without a seam. `_document` sets the same value
 * before hydration; this keeps it current when the appearance changes.
 */
function applyThemeColor(color: string) {
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => {
      meta.content = color;
    });
}

/** Resolve the saved appearance, and keep System in sync while the app is open. */
export function useTheme() {
  const mode = useUISettingsStore((s) => s.lightMode);
  const setMode = useUISettingsStore((s) => s.setLightMode);
  const reduceTransparency = useUISettingsStore((s) => s.reduceTransparency);
  const [isDark, setIsDark] = useState(false);
  const [canvasColor, setCanvasColor] = useState<string>();

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      const dark = mode === 'dark' || (mode === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      setIsDark(dark);
      const color = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg-canvas')
        .trim();
      setCanvasColor(color);
      if (color) applyThemeColor(color);
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [mode]);

  useEffect(() => {
    const root = document.documentElement;
    if (reduceTransparency) root.dataset.transparency = 'reduced';
    else delete root.dataset.transparency;
  }, [reduceTransparency]);

  return {
    mode,
    isDark,
    canvasColor,
    setMode,
    toggle: () => setMode(isDark ? 'light' : 'dark'),
  };
}
