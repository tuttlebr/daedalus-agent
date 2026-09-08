import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  calculateVisualViewportState,
  useVisualViewportKeyboard,
  type VisualViewportState,
} from '@/hooks/useVisualViewportKeyboard';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('visual viewport keyboard state', () => {
  it('detects a touch keyboard only when an editable control is focused', () => {
    expect(
      calculateVisualViewportState({
        baselineHeight: 852,
        viewportHeight: 500,
        offsetTop: 0,
        editableFocused: true,
        touchCapable: true,
      }),
    ).toEqual({
      height: 500,
      top: 0,
      occludedHeight: 352,
      keyboardOpen: true,
    });
  });

  it('does not treat desktop window resizing as a software keyboard', () => {
    expect(
      calculateVisualViewportState({
        baselineHeight: 900,
        viewportHeight: 650,
        offsetTop: 0,
        editableFocused: true,
        touchCapable: false,
      }).keyboardOpen,
    ).toBe(false);
  });

  it('keeps the keyboard open when iOS pans by the full height loss', () => {
    expect(
      calculateVisualViewportState({
        baselineHeight: 852,
        viewportHeight: 500,
        offsetTop: 352,
        editableFocused: true,
        touchCapable: true,
      }),
    ).toEqual({
      height: 500,
      top: 352,
      occludedHeight: 352,
      keyboardOpen: true,
    });
  });

  it('ignores small viewport shifts beneath the keyboard threshold', () => {
    expect(
      calculateVisualViewportState({
        baselineHeight: 852,
        viewportHeight: 790,
        offsetTop: 12,
        editableFocused: true,
        touchCapable: true,
      }).keyboardOpen,
    ).toBe(false);
  });

  it('uses pageTop when WebKit under-reports offsetTop', () => {
    expect(
      calculateVisualViewportState({
        baselineHeight: 852,
        viewportHeight: 500,
        offsetTop: 24,
        pageTop: 72,
        editableFocused: true,
        touchCapable: true,
      }).top,
    ).toBe(72);
  });

  it('corrects an unreported rendered body pan without stacking offsets', () => {
    const corrected = calculateVisualViewportState({
      baselineHeight: 852,
      viewportHeight: 500,
      offsetTop: 24,
      pageTop: 24,
      shellAppliedTop: 24,
      shellRenderedTop: -60,
      editableFocused: true,
      touchCapable: true,
    });
    expect(corrected.top).toBe(108);

    expect(
      calculateVisualViewportState({
        baselineHeight: 852,
        viewportHeight: 500,
        offsetTop: 24,
        pageTop: 24,
        shellAppliedTop: corrected.top!,
        shellRenderedTop: 24,
        editableFocused: true,
        touchCapable: true,
      }).top,
    ).toBe(108);
  });

  it('releases stale inline geometry after the viewport recovers', () => {
    expect(
      calculateVisualViewportState({
        baselineHeight: 852,
        viewportHeight: 852,
        offsetTop: 72,
        pageTop: 72,
        shellAppliedTop: 72,
        shellRenderedTop: 72,
        editableFocused: true,
        touchCapable: true,
        wasKeyboardOpen: true,
      }),
    ).toEqual({
      height: null,
      top: null,
      occludedHeight: 0,
      keyboardOpen: false,
    });
  });
});

describe('visual viewport lifecycle', () => {
  let root: Root;
  let input: HTMLTextAreaElement;
  let viewport: EventTarget & {
    height: number;
    offsetTop: number;
    pageTop: number;
    scale: number;
  };
  let state: VisualViewportState;
  const shellRef: { current: HTMLElement | null } = { current: null };

  function Probe() {
    state = useVisualViewportKeyboard(shellRef);
    return null;
  }

  function changeViewport(height: number, offsetTop = 0, scale = 1) {
    act(() => {
      Object.assign(viewport, { height, offsetTop, scale });
      viewport.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(400);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('innerHeight', 852);
    vi.stubGlobal('innerWidth', 393);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    viewport = Object.assign(new EventTarget(), {
      height: 852,
      offsetTop: 0,
      pageTop: 0,
      scale: 1,
    });
    vi.stubGlobal('visualViewport', viewport);
    input = document.createElement('textarea');
    const shell = document.createElement('main');
    shell.style.position = 'absolute';
    shell.style.top = '0px';
    shellRef.current = shell;
    const container = document.createElement('div');
    document.body.append(input, shell, container);
    root = createRoot(container);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    document.body.innerHTML = '';
    shellRef.current = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps the keyboard layout through blur, then discards a stale pan on close', () => {
    act(() => input.focus());
    changeViewport(500, 72);
    expect(state.keyboardOpen).toBe(true);
    act(() => {
      input.blur();
      vi.advanceTimersByTime(400);
    });
    expect(state).toMatchObject({
      keyboardOpen: true,
      height: 500,
      top: 72,
    });
    changeViewport(852, 72);
    expect(state).toMatchObject({
      keyboardOpen: false,
      height: null,
      top: null,
    });
  });

  it('corrects the shell from its rendered position when WebKit pans the body', () => {
    vi.spyOn(shellRef.current!, 'getBoundingClientRect').mockReturnValue({
      top: -84,
    } as DOMRect);
    viewport.pageTop = 24;
    act(() => input.focus());
    changeViewport(500, 24);
    expect(state.top).toBe(108);
  });

  it('leaves the layout alone during pinch zoom, even with a focused input', () => {
    act(() => input.focus());
    changeViewport(426, 100, 2);
    expect(state).toMatchObject({
      keyboardOpen: false,
      height: null,
      top: null,
    });
    changeViewport(500);
    expect(state).toMatchObject({ keyboardOpen: true, height: 500 });
  });

  it('relearns a smaller unfocused window instead of using a historical maximum', () => {
    vi.stubGlobal('innerHeight', 500);
    changeViewport(500);
    act(() => {
      input.focus();
      vi.advanceTimersByTime(400);
    });
    expect(state.keyboardOpen).toBe(false);
  });

  it('uses the new layout height when rotating with the keyboard open', () => {
    act(() => input.focus());
    changeViewport(500);
    vi.stubGlobal('innerWidth', 852);
    vi.stubGlobal('innerHeight', 393);
    changeViewport(200);
    expect(state).toMatchObject({ keyboardOpen: true, height: 200 });
    changeViewport(393);
    expect(state).toMatchObject({
      keyboardOpen: false,
      height: null,
      top: null,
    });
  });

  it('does not infer a keyboard from a read-only field', () => {
    input.readOnly = true;
    act(() => input.focus());
    changeViewport(500);
    expect(state.keyboardOpen).toBe(false);
  });
});
