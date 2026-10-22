import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useTheme } from '@/hooks/useTheme';

import { useUISettingsStore } from '@/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function Probe() {
  useTheme();
  return null;
}

describe('appearance on the document', () => {
  let root: Root;
  let container: HTMLDivElement;
  const html = document.documentElement;
  const themeColors = () =>
    Array.from(
      document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
    ).map((meta) => meta.getAttribute('content'));

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    // _document renders one tag per system appearance.
    document.head.innerHTML =
      '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">' +
      '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#161d27">';
    html.style.setProperty('--bg-canvas', 'rgb(22 29 39)');
    useUISettingsStore.setState({
      lightMode: 'dark',
      reduceTransparency: false,
    });
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.head.innerHTML = '';
    html.style.removeProperty('--bg-canvas');
    html.classList.remove('dark');
    delete html.dataset.theme;
    delete html.dataset.transparency;
    vi.unstubAllGlobals();
  });

  it('colours every theme-color tag with the canvas', () => {
    act(() => root.render(<Probe />));
    expect(html.dataset.theme).toBe('dark');
    expect(themeColors()).toEqual(['rgb(22 29 39)', 'rgb(22 29 39)']);
  });

  it('applies and clears reduced transparency', () => {
    act(() => root.render(<Probe />));
    expect(html.dataset.transparency).toBeUndefined();
    act(() => useUISettingsStore.setState({ reduceTransparency: true }));
    expect(html.dataset.transparency).toBe('reduced');
    act(() => useUISettingsStore.setState({ reduceTransparency: false }));
    expect(html.dataset.transparency).toBeUndefined();
  });
});
