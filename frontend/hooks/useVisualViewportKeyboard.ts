'use client';

import { type RefObject, useEffect, useState } from 'react';

const KEYBOARD_OCCLUSION_THRESHOLD_PX = 100;

export interface VisualViewportState {
  height: number | null;
  // CSS top needed to put the rendered shell on the visual viewport.
  top: number | null;
  occludedHeight: number;
  keyboardOpen: boolean;
}

const initialState: VisualViewportState = {
  height: null,
  top: null,
  occludedHeight: 0,
  keyboardOpen: false,
};

export function calculateVisualViewportState({
  baselineHeight,
  viewportHeight,
  offsetTop,
  pageTop = offsetTop,
  scrollY = 0,
  shellAppliedTop = 0,
  shellRenderedTop = shellAppliedTop,
  editableFocused,
  touchCapable,
  wasKeyboardOpen = false,
}: {
  baselineHeight: number;
  viewportHeight: number;
  offsetTop: number;
  pageTop?: number;
  scrollY?: number;
  shellAppliedTop?: number;
  shellRenderedTop?: number;
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

  // offsetTop and pageTop - scrollY describe the same visual edge. Current
  // WebKit builds can update one before the other, especially in an installed
  // web app, so use whichever has reached the larger non-negative value.
  const visualTop = keyboardOpen
    ? Math.max(0, offsetTop, pageTop - scrollY)
    : 0;
  // WebKit can pan the rendered body without exposing the full movement in
  // either viewport offset. Correct from the shell's observed position rather
  // than adding another inferred keyboard or body offset.
  const correctedTop = shellAppliedTop + visualTop - shellRenderedTop;
  const top =
    keyboardOpen || Math.abs(correctedTop) >= 0.5 ? correctedTop : null;

  return {
    // Once the keyboard closes, return sizing to CSS. Installed WebKit can
    // retain a stale visualViewport height after dismissal and rotation.
    height: keyboardOpen ? viewportHeight : null,
    top,
    occludedHeight: keyboardOpen ? candidateOcclusion : 0,
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
export function useVisualViewportKeyboard(
  shellRef: RefObject<HTMLElement>,
): VisualViewportState {
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
      const shell = shellRef.current;
      const computedTop = shell
        ? Number.parseFloat(window.getComputedStyle(shell).top) || 0
        : 0;
      const renderedTop = shell?.getBoundingClientRect().top ?? computedTop;
      const next = calculateVisualViewportState({
        baselineHeight,
        viewportHeight: nextHeight,
        offsetTop: viewport?.offsetTop ?? 0,
        pageTop:
          viewport?.pageTop ?? window.scrollY + (viewport?.offsetTop ?? 0),
        scrollY: window.scrollY,
        shellAppliedTop: computedTop,
        shellRenderedTop: renderedTop,
        editableFocused: focused,
        touchCapable,
        wasKeyboardOpen: keyboardOpen,
      });
      // Blur precedes the keyboard's closing animation; keep navigation hidden
      // until the viewport recovers instead of inserting it above the keyboard.
      keyboardOpen = next.keyboardOpen;

      setState((current) => {
        return current.height === next.height &&
          current.top === next.top &&
          current.occludedHeight === next.occludedHeight &&
          current.keyboardOpen === next.keyboardOpen
          ? current
          : next;
      });
    };

    const scheduleFrames = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        measure();
        // A second frame observes the shell after React applies the first
        // correction. This prevents native page panning from accumulating.
        frameId = requestAnimationFrame(measure);
      });
    };

    const scheduleMeasure = () => {
      scheduleFrames();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      // WebKit can initially report offsetTop as zero in standalone mode and
      // correct it shortly afterward without a dependable second event.
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        scheduleFrames();
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
    viewport?.addEventListener('scrollend', scheduleMeasure);
    window.addEventListener('resize', scheduleMeasure);
    window.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('orientationchange', resetBaseline);
    window.addEventListener('pageshow', scheduleMeasure);
    document.addEventListener('visibilitychange', scheduleMeasure);
    document.addEventListener('focusin', scheduleMeasure);
    document.addEventListener('focusout', scheduleMeasure);
    document.addEventListener('touchend', scheduleMeasure, { passive: true });

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      viewport?.removeEventListener('resize', scheduleMeasure);
      viewport?.removeEventListener('scroll', scheduleMeasure);
      viewport?.removeEventListener('scrollend', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('orientationchange', resetBaseline);
      window.removeEventListener('pageshow', scheduleMeasure);
      document.removeEventListener('visibilitychange', scheduleMeasure);
      document.removeEventListener('focusin', scheduleMeasure);
      document.removeEventListener('focusout', scheduleMeasure);
      document.removeEventListener('touchend', scheduleMeasure);
    };
  }, [shellRef]);

  return state;
}
