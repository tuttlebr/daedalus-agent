import { useUISettingsStore } from '@/state/uiSettingsStore';
import { afterEach, describe, expect, it } from 'vitest';

describe('UI settings persistence', () => {
  afterEach(() => {
    useUISettingsStore.getState().setReduceTransparency(false);
    localStorage.clear();
  });

  it('remembers reduced transparency for the next launch', () => {
    // _document reads this saved state before hydration.
    useUISettingsStore.getState().setReduceTransparency(true);
    const saved = JSON.parse(localStorage.getItem('ui-settings')!);
    expect(saved.state.reduceTransparency).toBe(true);
  });
});
