import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { InstallPrompt } from '@/components/pwa/InstallPrompt';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: Root;
let host: HTMLDivElement;
let displayMode: EventTarget & { matches: boolean };
function show() {
  act(() => root.render(<InstallPrompt />));
  act(() => vi.advanceTimersByTime(2500));
}

describe('Home Screen installation', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    localStorage.clear();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
    displayMode = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => displayMode),
    );
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Reflect.deleteProperty(navigator, 'standalone');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it('shows Safari instructions without waiting for beforeinstallprompt', () => {
    show();
    expect(host.textContent).toContain('Add to Home Screen');
    expect(host.textContent).toContain('Open as Web App');
    expect(host.querySelectorAll('button')).toHaveLength(1);
    act(() => host.querySelector('button')!.click());
    expect(host.textContent).toBe('');
    expect(Number(localStorage.getItem('pwa-install-dismissed'))).toBe(
      Date.now(),
    );
  });
  it.each(['navigator', 'media'])(
    'does not prompt an installed app (%s)',
    (signal) => {
      if (signal === 'navigator')
        Object.defineProperty(navigator, 'standalone', {
          configurable: true,
          value: true,
        });
      else displayMode.matches = true;
      show();
      expect(host.textContent).toBe('');
    },
  );
  it('respects dismissal and recovers after its cooldown', () => {
    localStorage.setItem('pwa-install-dismissed', String(Date.now()));
    show();
    expect(host.textContent).toBe('');
    act(() => root.render(null));
    act(() => vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000));
    show();
    expect(host.textContent).toContain('Add to Home Screen');
  });
  it('works when storage is unavailable and cleans up its timer', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    show();
    act(() => host.querySelector('button')!.click());
    expect(host.textContent).toBe('');
    act(() => root.render(null));
    act(() => root.render(<InstallPrompt />));
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps native installation on Chromium and hides on installation', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android Chrome');
    show();
    expect(host.textContent).toBe('');
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = Object.assign(
      new Event('beforeinstallprompt', { cancelable: true }),
      { prompt, userChoice: Promise.resolve({ outcome: 'accepted' }) },
    );
    act(() => window.dispatchEvent(event));
    act(() => vi.advanceTimersByTime(2500));
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === 'Install')!
        .click(),
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe('');
  });
  it('removes instructions when display mode changes', () => {
    show();
    act(() => {
      displayMode.matches = true;
      displayMode.dispatchEvent(new Event('change'));
    });
    expect(host.textContent).toBe('');
  });
  it('does not interrupt a task before or after the instructions appear', () => {
    act(() => root.render(<InstallPrompt />));
    act(() =>
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })),
    );
    act(() => vi.advanceTimersByTime(2500));
    expect(host.textContent).toBe('');
    act(() => root.render(null));
    show();
    expect(host.textContent).toContain('Add to Home Screen');
    act(() =>
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      ),
    );
    expect(host.textContent).toBe('');
  });
});
