import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { IMAGE_PRESETS } from '@/utils/app/imagePresets';

import { AdjustPopover } from '@/components/images/AdjustPopover';
import { PresetsPopover } from '@/components/images/PresetsPopover';

import { useImagePanelStore } from '@/state/imagePanelStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useMediaQuery', () => ({ useIsMobile: () => false }));

const preserveListOf = (id: string) =>
  IMAGE_PRESETS.find((preset) => preset.id === id)!.preserveList!;

// Desktop and mobile expose the same presets; applying one must update the
// draft identically from either entry point.
describe.each([
  ['desktop presets menu', PresetsPopover, 'Presets'],
  ['mobile adjust sheet', AdjustPopover, 'Adjust image'],
])('applying a preset from the %s', (_entry, Entry, triggerLabel) => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function apply(presetLabel: string) {
    act(() => root.render(<Entry />));
    act(() =>
      container
        .querySelector<HTMLButtonElement>(`[aria-label="${triggerLabel}"]`)!
        .click(),
    );
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) =>
        candidate.querySelector('div')?.textContent === presetLabel,
    );
    expect(button).toBeDefined();
    act(() => button!.click());
    return useImagePanelStore.getState();
  }

  it('keeps a preserve list the user wrote when the preset has none', () => {
    useImagePanelStore.setState({
      mode: 'edit',
      prompt: 'my cat',
      preserveList: 'face, red collar',
    });
    const state = apply('Studio Headshot');
    expect(state.prompt).toContain('my cat');
    expect(state.preserveList).toBe('face, red collar');
  });

  it('drops a preserve list that another preset supplied', () => {
    useImagePanelStore.setState({
      mode: 'edit',
      prompt: 'my cat',
      preserveList: preserveListOf('virtual-try-on'),
    });
    expect(apply('Studio Headshot').preserveList).toBe('');
  });

  it('uses the preserve list the preset supplies', () => {
    useImagePanelStore.setState({
      mode: 'edit',
      prompt: 'the lamp',
      preserveList: 'face, red collar',
    });
    expect(apply('Object Swap').preserveList).toBe(
      preserveListOf('object-swap'),
    );
  });
});
