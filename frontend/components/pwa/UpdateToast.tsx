'use client';

import { memo, useRef, useState } from 'react';

import { Button } from '@/components/primitives';

/** Let people finish their current task before replacing the page. */
export const UpdateToast = memo(() => {
  const [dismissed, setDismissed] = useState(false);
  const previousFocus = useRef(
    typeof document === 'undefined' ? null : document.activeElement,
  );

  if (dismissed) return null;

  return (
    <aside
      aria-label="App update"
      className="fixed left-4 right-4 top-[max(1rem,env(safe-area-inset-top))] z-[100] mx-auto max-w-md rounded-2xl border border-separator bg-panel p-4 text-primary shadow-lg"
    >
      <p role="status" className="text-sm">
        An update is ready. Finish any unsent edits before reloading.
      </p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            setDismissed(true);
            if (
              previousFocus.current instanceof HTMLElement &&
              previousFocus.current.isConnected
            )
              previousFocus.current.focus();
          }}
        >
          Later
        </Button>
        <Button variant="accent" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </aside>
  );
});

UpdateToast.displayName = 'UpdateToast';
