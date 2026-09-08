'use client';

import { useEffect, useState } from 'react';

const KEYBOARD_OCCLUSION_THRESHOLD_PX = 100;
const BODY_PAN_THRESHOLD_PX = 0.5;
const BLUR_GRACE_PERIOD_MS = 600;

export interface VisualViewportState {
  height: number | null;
  // Absolute CSS top that keeps the shell inside the visible viewport.
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function calculateVisualViewportState({
  baselineHeight,
  viewportHeight,
  offsetTop,
  scrollY = 0,
  pageTop = scrollY + offsetTop,
  renderedBodyTop = -scrollY,
  preferRenderedBodyPosition = false,
  compensateBodyAfterClose = false,
  editableFocused,
  touchCapable,
  wasKeyboardOpen = false,
}: {
  baselineHeight: number;
  viewportHeight: number;
  offsetTop: number;
  pageTop?: number;
  scrollY?: number;
  renderedBodyTop?: number;
  preferRenderedBodyPosition?: boolean;
  compensateBodyAfterClose?: boolean;
  editableFocused: boolean;
  touchCapable: boolean;
  wasKeyboardOpen?: boolean;
}): VisualViewportState {
  const candidateOcclusion = Math.max(0, baselineHeight - viewportHeight);
  const keyboardOpen =
    touchCapable &&
    (editableFocused || wasKeyboardOpen) &&
    candidateOcclusion >= KEYBOARD_OCCLUSION_THRESHOLD_PX;

  // pageTop and the body's rendered position are alternative observations of
  // the same viewport pan. Some installed WebKit builds leave pageTop and
  // offsetTop stale while getBoundingClientRect exposes the actual movement.
  // Choose one source; adding them recreates the keyboard gap.
  const reportedPageTop = Number.isFinite(pageTop)
    ? Math.max(0, pageTop)
    : Math.max(0, scrollY + offsetTop);
  const bodyPageTop = Math.max(0, -renderedBodyTop);
  const renderedBodyPan = Math.max(0, bodyPageTop - scrollY);
  const useRenderedBodyPosition =
    preferRenderedBodyPosition || renderedBodyPan > BODY_PAN_THRESHOLD_PX;

  let top: number | null = null;
  if (keyboardOpen) {
    // Keeping top + height within the layout viewport prevents an overflow
    // ancestor from clipping the composer during a full-height keyboard pan.
    top = clamp(
      useRenderedBodyPosition ? bodyPageTop : reportedPageTop,
      0,
      candidateOcclusion,
    );
  } else if (
    compensateBodyAfterClose &&
    useRenderedBodyPosition &&
    renderedBodyPan > BODY_PAN_THRESHOLD_PX
  ) {
    // WebKit can restore viewport.height before releasing its rendered body
    // pan. Keep the full-height shell aligned during that short close phase.
    top = bodyPageTop;
  }

  return {
    // CSS resumes control as soon as the keyboard is closed, even if WebKit
    // leaves an old visualViewport height behind after dismissal.
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
 * Sizes the app to the visual viewport while a touch keyboard is visible.
 * The layout viewport remains fixed so the conversation pane owns scrolling.
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
    let blurTimer: number | null = null;
    let keyboardOpen = false;
    let bodyPanMode = false;
    let blurGraceExpired = false;

    const measure = () => {
      frameId = null;
      // Pinch zoom also shrinks visualViewport.height. Leave application
      // geometry untouched while zoomed.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;

      const nextHeight = viewport?.height ?? window.innerHeight;
      const focused = isEditableElement(document.activeElement);
      if ((!focused && !keyboardOpen) || window.innerWidth !== layoutWidth) {
        baselineHeight = Math.max(window.innerHeight, nextHeight);
        layoutWidth = window.innerWidth;
      }

      const scrollY = window.scrollY;
      const renderedBodyTop = document.body.getBoundingClientRect().top;
      const renderedBodyPan = Math.max(0, -renderedBodyTop - scrollY);
      if (
        (focused || keyboardOpen) &&
        renderedBodyPan > BODY_PAN_THRESHOLD_PX
      ) {
        // Latch this source for the keyboard session. If WebKit later leaves a
        // stale positive offset while the rendered body returns to zero, the
        // stale API value cannot move the shell down again.
        bodyPanMode = true;
      }

      const next = calculateVisualViewportState({
        baselineHeight,
        viewportHeight: nextHeight,
        offsetTop: viewport?.offsetTop ?? 0,
        pageTop: viewport?.pageTop ?? scrollY + (viewport?.offsetTop ?? 0),
        scrollY,
        renderedBodyTop,
        preferRenderedBodyPosition: bodyPanMode,
        compensateBodyAfterClose: bodyPanMode,
        editableFocused: focused,
        touchCapable,
        wasKeyboardOpen: keyboardOpen && !blurGraceExpired,
      });

      keyboardOpen = next.keyboardOpen;
      if (!keyboardOpen && renderedBodyPan <= BODY_PAN_THRESHOLD_PX) {
        bodyPanMode = false;
      }

      setState((current) => {
        return current.height === next.height &&
          current.top === next.top &&
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
      // Standalone WebKit can finish viewport and body-pan updates without a
      // dependable final event.
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        frameId = requestAnimationFrame(measure);
      }, 300);
    };

    const resetBaseline = () => {
      baselineHeight = Math.max(
        window.innerHeight,
        viewport?.height ?? window.innerHeight,
      );
      bodyPanMode = false;
      blurGraceExpired = false;
      scheduleMeasure();
    };

    const handleFocusIn = () => {
      blurGraceExpired = false;
      if (blurTimer !== null) {
        window.clearTimeout(blurTimer);
        blurTimer = null;
      }
      scheduleMeasure();
    };

    const handleFocusOut = () => {
      scheduleMeasure();
      if (blurTimer !== null) window.clearTimeout(blurTimer);
      // Blur precedes the keyboard animation. Give it time to close, then stop
      // trusting a stale shrunken visualViewport if WebKit never restores it.
      blurTimer = window.setTimeout(() => {
        blurTimer = null;
        if (!isEditableElement(document.activeElement)) {
          blurGraceExpired = true;
          scheduleMeasure();
        }
      }, BLUR_GRACE_PERIOD_MS);
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
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    document.addEventListener('touchend', scheduleMeasure, { passive: true });

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      if (blurTimer !== null) window.clearTimeout(blurTimer);
      viewport?.removeEventListener('resize', scheduleMeasure);
      viewport?.removeEventListener('scroll', scheduleMeasure);
      viewport?.removeEventListener('scrollend', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('orientationchange', resetBaseline);
      window.removeEventListener('pageshow', scheduleMeasure);
      document.removeEventListener('visibilitychange', scheduleMeasure);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      document.removeEventListener('touchend', scheduleMeasure);
    };
  }, []);

  return state;
}
