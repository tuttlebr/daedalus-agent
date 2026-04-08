'use client';

import { memo, useEffect } from 'react';

interface UpdateToastProps {
  onDismiss: () => void;
}

/**
 * Silently reloads the page when a service worker update is available.
 * No visible UI - prevents mobile overlay blocking issues.
 */
export const UpdateToast = memo(({ onDismiss }: UpdateToastProps) => {
  useEffect(() => {
    window.location.reload();
  }, []);

  return null;
});

UpdateToast.displayName = 'UpdateToast';
