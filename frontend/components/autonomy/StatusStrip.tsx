'use client';

import { IconAdjustments, IconRefresh } from '@tabler/icons-react';
import { forwardRef, type ReactNode } from 'react';

import type { AutonomyConfig, AutonomyRun } from '@/types/autonomy';

import { isActiveRun, nextRunCountdown, relativeTime } from './utils';

import classNames from 'classnames';

interface StatusStripProps {
  config: AutonomyConfig | null;
  activeRun: AutonomyRun | undefined;
  lastRunAt: number | null;
  queuedRequests: number;
  onOpenWorkspace: () => void;
  onRefresh: () => void;
  /** True while a manual/automatic refresh is in flight */
  refreshing?: boolean;
  wsConnected: boolean;
}

export const StatusStrip = forwardRef<HTMLButtonElement, StatusStripProps>(
  function StatusStrip(
    {
      config,
      activeRun,
      lastRunAt,
      queuedRequests,
      onOpenWorkspace,
      onRefresh,
      refreshing = false,
      wsConnected,
    },
    workspaceButtonRef,
  ) {
    const enabled = !!config?.enabled;
    const live = isActiveRun(activeRun);
    const next = nextRunCountdown(config);
    const last = relativeTime(lastRunAt);

    return (
      <div className="sticky top-0 z-30 -mx-4 mb-4 border-b border-separator/70 app-chrome px-4 py-3 backdrop-blur-xl md:-mx-6 md:px-6">
        <div className="mx-auto flex max-w-[720px] items-center gap-3">
          <PulseDot live={live} enabled={enabled} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <h1 className="font-display text-base font-semibold tracking-tight text-dark-text-primary">
                Autonomy
              </h1>
              <span className="font-mono text-[0.75rem] uppercase tracking-[0.18em] text-dark-text-subtle">
                {enabled ? (live ? 'thinking' : 'idle') : 'paused'}
              </span>
            </div>
            <div className="mt-0.5 truncate font-mono text-[0.75rem] text-dark-text-muted">
              <Meta>last {last}</Meta>
              {enabled && next && (
                <>
                  <Sep />
                  <Meta>next {next}</Meta>
                </>
              )}
              {queuedRequests > 0 && (
                <>
                  <Sep />
                  <Meta>{queuedRequests} queued</Meta>
                </>
              )}
              {!wsConnected && (
                <>
                  <Sep />
                  <Meta className="text-nvidia-orange">reconnecting…</Meta>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <IconChrome
              onClick={onRefresh}
              label={refreshing ? 'Refreshing' : 'Refresh'}
              disabled={refreshing}
            >
              <IconRefresh
                size={15}
                className={refreshing ? 'animate-spin' : undefined}
              />
            </IconChrome>
            <IconChrome
              onClick={onOpenWorkspace}
              label="Open workspace"
              ref={workspaceButtonRef}
            >
              <IconAdjustments size={16} />
            </IconChrome>
          </div>
        </div>
      </div>
    );
  },
);

function PulseDot({ live, enabled }: { live: boolean; enabled: boolean }) {
  return (
    <span
      className="relative inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center"
      aria-hidden
    >
      <span
        className={classNames(
          'absolute inset-0 rounded-full',
          enabled ? 'bg-nvidia-green' : 'bg-control',
          live && 'animate-ping opacity-60',
        )}
      />
      <span
        className={classNames(
          'relative h-2 w-2 rounded-full',
          enabled
            ? 'bg-nvidia-green shadow-[0_0_10px_rgba(118,185,0,0.6)]'
            : 'bg-control',
        )}
      />
    </span>
  );
}

function Meta({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span className={className}>{children}</span>;
}

function Sep() {
  return <span className="mx-1.5 text-dark-text-subtle">·</span>;
}

const IconChrome = forwardRef<
  HTMLButtonElement,
  {
    children: ReactNode;
    onClick: () => void;
    label: string;
    disabled?: boolean;
  }
>(function IconChrome({ children, onClick, label, disabled = false }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      disabled={disabled}
      className="grid h-11 w-11 place-items-center rounded-full text-dark-text-muted transition hover:bg-fill/[0.06] hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40 disabled:pointer-events-none disabled:opacity-60"
    >
      {children}
    </button>
  );
});
