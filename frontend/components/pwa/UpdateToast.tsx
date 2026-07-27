'use client';

import { memo, useEffect } from 'react';

/**
 * Silently reloads the page when a service worker update is available.
 * No visible UI - prevents mobile overlay blocking issues.
 */
export const UpdateToast = memo(() => {
  useEffect(() => {
    window.location.reload();
  }, []);

  return null;
});

UpdateToast.displayName = 'UpdateToast';
