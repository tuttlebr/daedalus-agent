'use client';

import { useEffect, useState } from 'react';

const KEYBOARD_OCCLUSION_THRESHOLD_PX = 100;

export interface VisualViewportState {
  height: number | null;
  // Top of the visual viewport within the layout viewport, for a fixed shell.
  offsetTop: number;
  occludedHeight: number;
  keyboardOpen: boolean;
}

const initialState: VisualViewportState = {
  height: null,
  offsetTop: 0,
  occludedHeight: 0,
  keyboardOpen: false,
};

export function calculateVisualViewportState({
  baselineHeight,
  viewportHeight,
  offsetTop,
  editableFocused,
  touchCapable,
  wasKeyboardOpen = false,
}: {
  baselineHeight: number;
  viewportHeight: number;
  offsetTop: number;
  editableFocused: boolean;
  touchCapable: boolean;
  wasKeyboardOpen?: boolean;
}): VisualViewportState {
  // Treat the viewport pan and the keyboard's height reduction as independent
  // signals. On iOS the pan can be almost identical to the height loss; adding
  // offsetTop here would cancel the keyboard signal and make the app expand
  // while the keyboard is still visible.
  const candidateOcclusion = Math.max(0, baselineHeight - viewportHeight);
  const keyboardOpen =
    touchCapable &&
    (editableFocused || wasKeyboardOpen) &&
    candidateOcclusion >= KEYBOARD_OCCLUSION_THRESHOLD_PX;

  return {
    height: Math.round(viewportHeight),
    // WebKit can retain its last pan after dismissal. Do not move the shell
    // once the visible height has recovered.
    offsetTop: keyboardOpen ? Math.round(Math.max(0, offsetTop)) : 0,
    occludedHeight: Math.round(keyboardOpen ? candidateOcclusion : 0),
    keyboardOpen,
  };
}

function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement)
    return !element.disabled && !element.readOnly;
  if (
    !(element instanceof HTMLInputElement) ||
    element.disabled ||
    element.readOnly
  )
    return false;

  return ![
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ].includes(element.type);
}

/**
 * Tracks the visible iOS viewport instead of assuming that `100dvh` shrinks
 * with the software keyboard. The focus check prevents rotation, split-view,
 * and browser chrome changes from being misclassified as keyboard input.
 */
export function useVisualViewportKeyboard(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(initialState);

  useEffect(() => {
    const viewport = window.visualViewport;
    let baselineHeight = Math.max(
      window.innerHeight,
      viewport?.height ?? window.innerHeight,
    );
    let layoutWidth = window.innerWidth;
    const touchCapable =
      navigator.maxTouchPoints > 0 ||
      window.matchMedia?.('(pointer: coarse)').matches === true;
    let frameId: number | null = null;
    let settleTimer: number | null = null;
    let keyboardOpen = false;

    const measure = () => {
      frameId = null;
      // Pinch zoom also shrinks visualViewport.height. Leave the app's layout
      // alone while zoomed so that zooming cannot open the keyboard layout.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      const nextHeight = viewport?.height ?? window.innerHeight;
      const focused = isEditableElement(document.activeElement);
      // A genuine resize with no keyboard establishes a new baseline. Keeping
      // the largest height forever misclassifies the next focus after rotation
      // or a smaller window as another keyboard opening.
      if ((!focused && !keyboardOpen) || window.innerWidth !== layoutWidth) {
        baselineHeight = Math.max(window.innerHeight, nextHeight);
        layoutWidth = window.innerWidth;
      }
      const next = calculateVisualViewportState({
        baselineHeight,
        viewportHeight: nextHeight,
        // Fixed positioning already accounts for document scrolling. Mixing
        // pageTop, scrollY or body bounds into this moves the shell twice.
        offsetTop: viewport?.offsetTop ?? 0,
        editableFocused: focused,
        touchCapable,
        wasKeyboardOpen: keyboardOpen,
      });
      // Blur precedes the keyboard's closing animation; keep navigation hidden
      // until the viewport recovers instead of inserting it above the keyboard.
      keyboardOpen = next.keyboardOpen;

      setState((current) => {
        return current.height === next.height &&
          current.offsetTop === next.offsetTop &&
          current.occludedHeight === next.occludedHeight &&
          current.keyboardOpen === next.keyboardOpen
          ? current
          : next;
      });
    };

    const scheduleMeasure = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      frameId = requestAnimationFrame(measure);
      // WebKit can initially report offsetTop as zero in standalone mode and
      // correct it shortly afterward without a dependable second event.
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        measure();
      }, 300);
    };

    const resetBaseline = () => {
      baselineHeight = Math.max(
        window.innerHeight,
        viewport?.height ?? window.innerHeight,
      );
      scheduleMeasure();
    };

    measure();
    viewport?.addEventListener('resize', scheduleMeasure);
    viewport?.addEventListener('scroll', scheduleMeasure);
    window.addEventListener('resize', scheduleMeasure);
    window.addEventListener('orientationchange', resetBaseline);
    window.addEventListener('pageshow', scheduleMeasure);
    document.addEventListener('visibilitychange', scheduleMeasure);
    document.addEventListener('focusin', scheduleMeasure);
    document.addEventListener('focusout', scheduleMeasure);

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      viewport?.removeEventListener('resize', scheduleMeasure);
      viewport?.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('orientationchange', resetBaseline);
      window.removeEventListener('pageshow', scheduleMeasure);
      document.removeEventListener('visibilitychange', scheduleMeasure);
      document.removeEventListener('focusin', scheduleMeasure);
      document.removeEventListener('focusout', scheduleMeasure);
    };
  }, []);

  return state;
}
