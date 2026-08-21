import { calculateVisualViewportState } from '@/hooks/useVisualViewportKeyboard';

import { describe, expect, it } from 'vitest';

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
      offsetTop: 0,
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
      offsetTop: 352,
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
});
