'use client';

import { IconAdjustments, IconBell, IconRefresh } from '@tabler/icons-react';
import { forwardRef, type ReactNode } from 'react';

import type { AutonomyConfig, AutonomyRun } from '@/types/autonomy';

import { nextRunCountdown, relativeTime } from './utils';

import classNames from 'classnames';

interface StatusStripProps {
  config: AutonomyConfig | null;
  activeRun: AutonomyRun | undefined;
  lastRunAt: number | null;
  pendingApprovals: number;
  queuedRequests: number;
  onOpenWorkspace: () => void;
  onRefresh: () => void;
  wsConnected: boolean;
}

export const StatusStrip = forwardRef<HTMLButtonElement, StatusStripProps>(
  function StatusStrip(
    {
      config,
      activeRun,
      lastRunAt,
      pendingApprovals,
      queuedRequests,
      onOpenWorkspace,
      onRefresh,
      wsConnected,
    },
    workspaceButtonRef,
  ) {
    const enabled = !!config?.enabled;
    const live =
      !!activeRun &&
      ['running', 'queued', 'waiting_approval'].includes(activeRun.status);
    const next = nextRunCountdown(config);
    const last = relativeTime(lastRunAt);

    return (
      <div className="sticky top-0 z-30 -mx-4 mb-4 border-b border-white/[0.04] bg-[rgba(10,11,12,0.78)] px-4 py-3 backdrop-blur-xl md:-mx-6 md:px-6">
        <div className="mx-auto flex max-w-[720px] items-center gap-3">
          <PulseDot live={live} enabled={enabled} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <h1 className="font-display text-base font-semibold tracking-tight text-dark-text-primary">
                Daedalus
              </h1>
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-dark-text-subtle">
                {enabled ? (live ? 'thinking' : 'idle') : 'paused'}
              </span>
            </div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-dark-text-muted">
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
                  <Meta className="text-amber-300/80">reconnecting…</Meta>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {pendingApprovals > 0 && (
              <span
                className="flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-1 text-[11px] font-medium text-amber-200"
                aria-label={`${pendingApprovals} pending approval${
                  pendingApprovals === 1 ? '' : 's'
                }`}
              >
                <IconBell size={12} />
                {pendingApprovals}
              </span>
            )}
            <IconChrome onClick={onRefresh} label="Refresh">
              <IconRefresh size={15} />
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
          enabled ? 'bg-nvidia-green' : 'bg-neutral-500',
          live && 'animate-ping opacity-60',
        )}
      />
      <span
        className={classNames(
          'relative h-2 w-2 rounded-full',
          enabled
            ? 'bg-nvidia-green shadow-[0_0_10px_rgba(118,185,0,0.6)]'
            : 'bg-neutral-500',
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
  { children: ReactNode; onClick: () => void; label: string }
>(function IconChrome({ children, onClick, label }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid h-11 w-11 place-items-center rounded-full text-dark-text-muted transition hover:bg-white/[0.06] hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40"
    >
      {children}
    </button>
  );
});
