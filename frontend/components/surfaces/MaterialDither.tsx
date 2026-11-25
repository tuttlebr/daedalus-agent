import { useEffect, useRef } from 'react';

import type { MaterialPaint } from './material.worker';

/** Paint only when the surface, display scale or appearance changes. The CSS
 * material supplies the first frame and the fallback if painting is unavailable. */
export function MaterialDither({ kind }: { kind: MaterialPaint['kind'] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (
      !canvas ||
      typeof Worker === 'undefined' ||
      typeof ResizeObserver === 'undefined'
    )
      return;
    const context = canvas.getContext('2d', { alpha: kind === 'reflection' });
    if (!context) return;
    let worker: Worker | undefined;
    let requested: MaterialPaint | undefined;
    let inFlight: MaterialPaint | undefined;
    let canDisplay = false;
    let lastKey = '';
    let frame = 0;

    const release = () => {
      worker?.terminate();
      worker = undefined;
      requested = undefined;
      inFlight = undefined;
      lastKey = '';
      delete canvas.dataset.ready;
      canvas.width = 1;
      canvas.height = 1;
    };

    function sendLatest() {
      if (!worker || !requested || inFlight) return;
      inFlight = requested;
      canDisplay = true;
      worker.postMessage(requested);
    }

    const measure = () => {
      const bounds = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio;
      const width = Math.round(bounds.width * scale);
      const height = Math.round(bounds.height * scale);
      if (!width || !height) {
        if (worker) release();
        return;
      }
      const style = getComputedStyle(canvas);
      const rgb = (name: string) =>
        style.getPropertyValue(name).trim().split(/\s+/).map(Number);
      const opacity = (name: string) => Number(style.getPropertyValue(name));
      const wash = kind === 'wash';
      const paint = {
        kind,
        width,
        height,
        edge: Math.max(1, parseFloat(style.fontSize) * scale),
        base: rgb(wash ? '--app' : '--glass-tint'),
        start: rgb(wash ? '--palette-glacier' : '--palette-white'),
        end: rgb(wash ? '--palette-apricot' : '--reflection-end'),
        startOpacity: opacity(
          wash ? '--canvas-wash' : '--reflection-start-opacity',
        ),
        endOpacity: opacity(
          wash ? '--canvas-wash' : '--reflection-end-opacity',
        ),
        tintOpacity: wash ? 1 : opacity('--sidebar-tint-opacity'),
      };
      const key = JSON.stringify(paint);
      if (key === lastKey) return;
      lastKey = key;
      requested = paint;
      if (!worker) {
        try {
          worker = new Worker(new URL('./material.worker.ts', import.meta.url));
        } catch {
          return;
        }
        worker.onerror = release;
        worker.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
          const painted = inFlight;
          inFlight = undefined;
          // Present completed frames during a live drag and coalesce sizes
          // that arrived while painting. Discard frames from a prior theme.
          if (painted && canDisplay) {
            try {
              if (canvas.width !== painted.width) canvas.width = painted.width;
              if (canvas.height !== painted.height)
                canvas.height = painted.height;
              context.putImageData(
                new ImageData(
                  new Uint8ClampedArray(data),
                  painted.width,
                  painted.height,
                ),
                0,
                0,
              );
              canvas.dataset.ready = '';
            } catch {
              release();
            }
          }
          if (painted !== requested) sendLatest();
        };
      }
      sendLatest();
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const invalidate = () => {
      canDisplay = false;
      requested = undefined;
      delete canvas.dataset.ready;
      lastKey = '';
      schedule();
    };
    const size = new ResizeObserver(schedule);
    size.observe(canvas);
    const appearance = new MutationObserver(invalidate);
    appearance.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-transparency', 'style'],
    });
    // Moving a window between displays can change DPR without a CSS resize.
    let resolution: MediaQueryList;
    const watchScale = () => {
      resolution = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      resolution.addEventListener('change', watchScale, { once: true });
      schedule();
    };
    watchScale();
    window.addEventListener('resize', schedule);
    canvas.addEventListener('contextrestored', invalidate);
    return () => {
      size.disconnect();
      appearance.disconnect();
      resolution.removeEventListener('change', watchScale);
      window.removeEventListener('resize', schedule);
      canvas.removeEventListener('contextrestored', invalidate);
      cancelAnimationFrame(frame);
      release();
    };
  }, [kind]);

  return (
    <canvas
      ref={ref}
      width={1}
      height={1}
      className="material-dither"
      data-material={kind}
      aria-hidden="true"
    />
  );
}
