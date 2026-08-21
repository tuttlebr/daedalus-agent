'use client';

import { useEffect, useState } from 'react';

const KEYBOARD_OCCLUSION_THRESHOLD_PX = 100;

export interface VisualViewportState {
  height: number | null;
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
}: {
  baselineHeight: number;
  viewportHeight: number;
  offsetTop: number;
  editableFocused: boolean;
  touchCapable: boolean;
}): VisualViewportState {
  const candidateOcclusion = Math.max(
    0,
    baselineHeight - (viewportHeight + offsetTop),
  );
  const keyboardOpen =
    touchCapable &&
    editableFocused &&
    candidateOcclusion >= KEYBOARD_OCCLUSION_THRESHOLD_PX;

  return {
    height: Math.round(viewportHeight),
    offsetTop: Math.round(offsetTop),
    occludedHeight: Math.round(keyboardOpen ? candidateOcclusion : 0),
    keyboardOpen,
  };
}

function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return !element.disabled;
  if (!(element instanceof HTMLInputElement) || element.disabled) return false;

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
    const touchCapable =
      navigator.maxTouchPoints > 0 ||
      window.matchMedia?.('(pointer: coarse)').matches === true;
    let frameId: number | null = null;

    const measure = () => {
      frameId = null;
      const nextHeight = viewport?.height ?? window.innerHeight;
      const offsetTop = viewport?.offsetTop ?? 0;
      const focused = isEditableElement(document.activeElement);
      const next = calculateVisualViewportState({
        baselineHeight,
        viewportHeight: nextHeight,
        offsetTop,
        editableFocused: focused,
        touchCapable,
      });
      const candidateOcclusion = Math.max(
        0,
        baselineHeight - (nextHeight + offsetTop),
      );

      if (!focused && candidateOcclusion < KEYBOARD_OCCLUSION_THRESHOLD_PX) {
        baselineHeight = Math.max(baselineHeight, nextHeight + offsetTop);
      }

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
      frameId = requestAnimationFrame(measure);
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
    document.addEventListener('focusin', scheduleMeasure);
    document.addEventListener('focusout', scheduleMeasure);

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      viewport?.removeEventListener('resize', scheduleMeasure);
      viewport?.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('orientationchange', resetBaseline);
      document.removeEventListener('focusin', scheduleMeasure);
      document.removeEventListener('focusout', scheduleMeasure);
    };
  }, []);

  return state;
}
