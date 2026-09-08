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
      }),
    ).toEqual({
      height: null,
      top: null,
      occludedHeight: 0,
      keyboardOpen: false,
    });
  });

  it('uses the reported page position when the body has not moved', () => {
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

    // A newer, smaller pageTop wins over a stale larger offsetTop.
    expect(
      calculateVisualViewportState({
        baselineHeight: 852,
        viewportHeight: 500,
        offsetTop: 72,
        pageTop: 24,
        editableFocused: true,
        touchCapable: true,
      }).top,
    ).toBe(24);
  });

  it('includes document scroll once when pageTop is unavailable', () => {
    expect(
      calculateVisualViewportState({
        baselineHeight: 852,
        viewportHeight: 500,
        offsetTop: 24,
        scrollY: 100,
        renderedBodyTop: -100,
        editableFocused: true,
        touchCapable: true,
      }).top,
    ).toBe(124);
  });

  it('treats rendered body pan and viewport offsets as alternatives', () => {
    const correlated = calculateVisualViewportState({
      baselineHeight: 852,
      viewportHeight: 500,
      offsetTop: 84,
      pageTop: 84,
      renderedBodyTop: -84,
      editableFocused: true,
      touchCapable: true,
    });
    expect(correlated.top).toBe(84);

    const underReported = calculateVisualViewportState({
      baselineHeight: 852,
      viewportHeight: 500,
      offsetTop: 24,
      pageTop: 24,
      renderedBodyTop: -84,
      editableFocused: true,
      touchCapable: true,
    });
    expect(underReported.top).toBe(84);
  });

  it('keeps the rendered body authoritative as its pan decreases', () => {
    expect(
      calculateVisualViewportState({
        baselineHeight: 852,
        viewportHeight: 500,
        offsetTop: 72,
        pageTop: 72,
        renderedBodyTop: -24,
        preferRenderedBodyPosition: true,
        editableFocused: true,
        touchCapable: true,
      }).top,
    ).toBe(24);

    expect(
      calculateVisualViewportState({
        baselineHeight: 852,
        viewportHeight: 500,
        offsetTop: 72,
        pageTop: 72,
        renderedBodyTop: 0,
        preferRenderedBodyPosition: true,
        editableFocused: true,
        touchCapable: true,
      }).top,
    ).toBe(0);
  });

  it('keeps the resized shell inside its clipping rectangle', () => {
    expect(
      calculateVisualViewportState({
        baselineHeight: 852,
        viewportHeight: 500,
        offsetTop: 704,
        pageTop: 704,
        renderedBodyTop: -704,
        editableFocused: true,
        touchCapable: true,
      }).top,
    ).toBe(352);
  });

  it('ignores viewport changes below the keyboard threshold', () => {
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

  it('releases stale viewport values when the keyboard is closed', () => {
    expect(
      calculateVisualViewportState({
        baselineHeight: 852,
        viewportHeight: 852,
        offsetTop: 72,
        pageTop: 72,
        renderedBodyTop: 0,
        preferRenderedBodyPosition: true,
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

  it('can compensate a body pan while the keyboard finishes closing', () => {
    expect(
      calculateVisualViewportState({
        baselineHeight: 852,
        viewportHeight: 852,
        offsetTop: 84,
        pageTop: 84,
        renderedBodyTop: -84,
        preferRenderedBodyPosition: true,
        compensateBodyAfterClose: true,
        editableFocused: false,
        touchCapable: true,
      }),
    ).toEqual({
      height: null,
      top: 84,
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
  let bodyTop: number;

  function Probe() {
    state = useVisualViewportKeyboard();
    return null;
  }

  function changeViewport(
    height: number,
    offsetTop = 0,
    scale = 1,
    pageTop = offsetTop,
  ) {
    act(() => {
      Object.assign(viewport, { height, offsetTop, scale, pageTop });
      viewport.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(400);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('innerHeight', 852);
    vi.stubGlobal('innerWidth', 393);
    vi.stubGlobal('scrollY', 0);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    viewport = Object.assign(new EventTarget(), {
      height: 852,
      offsetTop: 0,
      pageTop: 0,
      scale: 1,
    });
    vi.stubGlobal('visualViewport', viewport);
    bodyTop = 0;
    vi.spyOn(document.body, 'getBoundingClientRect').mockImplementation(
      () => ({ top: bodyTop } as DOMRect),
    );
    input = document.createElement('textarea');
    const container = document.createElement('div');
    document.body.append(input, container);
    root = createRoot(container);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps the keyboard layout through blur, then discards stale offsets on close', () => {
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

  it('does not stay open when WebKit leaves a stale shrunken viewport after blur', () => {
    act(() => input.focus());
    changeViewport(500);
    act(() => {
      input.blur();
      vi.advanceTimersByTime(1_000);
    });
    expect(state).toMatchObject({
      keyboardOpen: false,
      height: null,
      top: null,
    });
  });

  it('latches rendered body movement without accumulating API offsets', () => {
    bodyTop = -84;
    act(() => input.focus());
    changeViewport(500, 84);
    expect(state.top).toBe(84);

    bodyTop = -24;
    changeViewport(500, 72);
    expect(state.top).toBe(24);

    bodyTop = 0;
    changeViewport(500, 72);
    expect(state.top).toBe(0);
  });

  it('keeps a closing body pan aligned until its rendered position recovers', () => {
    bodyTop = -84;
    act(() => input.focus());
    changeViewport(500, 24);
    expect(state).toMatchObject({ keyboardOpen: true, top: 84 });

    act(() => input.blur());
    changeViewport(852, 84);
    expect(state).toMatchObject({
      keyboardOpen: false,
      height: null,
      top: 84,
    });

    bodyTop = 0;
    act(() => {
      viewport.dispatchEvent(new Event('scrollend'));
      vi.advanceTimersByTime(400);
    });
    expect(state.top).toBeNull();
  });

  it('leaves the layout alone during pinch zoom', () => {
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
