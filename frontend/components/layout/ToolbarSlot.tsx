'use client';

import React, { createContext, forwardRef, useContext } from 'react';
import { createPortal } from 'react-dom';

import { IconButton } from '@/components/primitives';

import { useUISettingsStore, type AppView } from '@/state/uiSettingsStore';
import classNames from 'classnames';

/** The shared toolbar's item slot, published only while the toolbar is shown. */
const ToolbarSlotContext = createContext<HTMLElement | null>(null);
/** The destination that a subtree belongs to. */
const ViewContext = createContext<AppView | null>(null);
/** True for controls rendered into the shared toolbar. */
const InToolbarContext = createContext(false);
/** True inside a group, which supplies the glass for its controls. */
const InGroupContext = createContext(false);

export const ToolbarSlotProvider = ToolbarSlotContext.Provider;
export const ViewProvider = ViewContext.Provider;
export const useInToolbar = () => useContext(InToolbarContext);
/** True while the shared toolbar is shown and hosts destination controls. */
export const useToolbarShown = () => useContext(ToolbarSlotContext) !== null;

/**
 * A destination's own controls. While the shared toolbar is shown they move
 * into it, as Chat's title and New chat do, and only for the destination on
 * screen. Compact and keyboard layouts hide the toolbar, so the controls stay
 * where they are written.
 */
export function ToolbarItems({ children }: { children: React.ReactNode }) {
  const slot = useContext(ToolbarSlotContext);
  const view = useContext(ViewContext);
  const activeView = useUISettingsStore((s) => s.activeView);
  if (!slot) return <>{children}</>;
  if (view !== null && view !== activeView) return null;
  return createPortal(
    <InToolbarContext.Provider value={true}>
      {children}
    </InToolbarContext.Provider>,
    slot,
  );
}

/** Related toolbar controls share one glass capsule. */
export function ToolbarGroup({
  children,
  className,
  label,
}: {
  children: React.ReactNode;
  className?: string;
  label?: string;
}) {
  const inToolbar = useInToolbar();
  return (
    <div
      role="group"
      aria-label={label}
      className={classNames(
        inToolbar ? 'app-chrome app-toolbar-group' : 'flex items-center gap-1',
        className,
      )}
    >
      <InGroupContext.Provider value={true}>{children}</InGroupContext.Provider>
    </div>
  );
}

export interface ToolbarButtonProps {
  icon: React.ReactElement;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}

/**
 * An icon command with its name for assistive technology and as a tooltip.
 * Alone in the toolbar it is a glass circle; inside a group, the group
 * supplies the glass.
 */
export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(
  ({ icon, label, onClick, disabled, busy, className }, ref) => {
    const inToolbar = useInToolbar();
    const inGroup = useContext(InGroupContext);
    return (
      <IconButton
        ref={ref}
        icon={icon}
        aria-label={label}
        variant="ghost"
        isLoading={busy}
        disabled={disabled}
        onClick={onClick}
        className={classNames(
          inToolbar && !inGroup && 'app-chrome app-toolbar-button',
          inToolbar && inGroup && 'app-toolbar-item',
          'flex-shrink-0',
          className,
        )}
      />
    );
  },
);

ToolbarButton.displayName = 'ToolbarButton';
