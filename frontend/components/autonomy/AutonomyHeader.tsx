'use client';

import { IconAdjustments, IconRefresh } from '@tabler/icons-react';
import { forwardRef, type ReactNode } from 'react';

import type { AutonomyConfig, AutonomyRun } from '@/types/autonomy';

import { PageHeader } from '@/components/layout/PageHeader';
import { ToolbarButton, ToolbarGroup } from '@/components/layout/ToolbarSlot';

import { isActiveRun, nextRunCountdown, relativeTime } from './utils';

import classNames from 'classnames';

interface AutonomyHeaderProps {
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

/**
 * Autonomy's title and run status in the shared page header. Refresh and the
 * workspace are commands, so wide windows show them in the toolbar.
 */
export const AutonomyHeader = forwardRef<
  HTMLButtonElement,
  AutonomyHeaderProps
>(function AutonomyHeader(
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
    <PageHeader
      title="Autonomy"
      badge={
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-dark-text-muted">
          <PulseDot live={live} enabled={enabled} />
          {enabled ? (live ? 'Thinking' : 'Idle') : 'Paused'}
        </span>
      }
      description={
        <span className="tabular-nums text-dark-text-muted">
          <Meta>{lastRunAt ? `Last run ${last}` : 'No runs yet'}</Meta>
          {enabled && next && (
            <>
              <Sep />
              <Meta>Next {next}</Meta>
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
              <Meta className="text-nvidia-orange">Reconnecting…</Meta>
            </>
          )}
        </span>
      }
      actions={
        <ToolbarGroup label="Autonomy commands">
          <ToolbarButton
            icon={
              <IconRefresh
                className={refreshing ? 'animate-spin' : undefined}
              />
            }
            label={refreshing ? 'Refreshing' : 'Refresh'}
            disabled={refreshing}
            onClick={onRefresh}
          />
          <ToolbarButton
            ref={workspaceButtonRef}
            icon={<IconAdjustments />}
            label="Open workspace"
            onClick={onOpenWorkspace}
          />
        </ToolbarGroup>
      }
    />
  );
});

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
          // Paused reads as an empty ring rather than a fill matching the bar.
          enabled
            ? 'bg-nvidia-green shadow-[0_0_10px_rgb(var(--accent)/0.6)]'
            : 'border border-separator',
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
