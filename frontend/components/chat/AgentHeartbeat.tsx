'use client';

import { IconChevronRight } from '@tabler/icons-react';
import { memo } from 'react';

import type {
  ConsolidatedStep,
  OperationStatus,
} from '@/utils/app/intermediateSteps';

import { ActivityIcon } from '@/components/agent/ActivityIcon';

interface AgentHeartbeatProps {
  label: string;
  detail?: string;
  elapsed?: string;
  status: OperationStatus;
  step?: ConsolidatedStep;
  writing?: boolean;
  expanded: boolean;
  onClick: () => void;
}

/** One stable line opens the turn's activity without shifting the conversation. */
export const AgentHeartbeat = memo(
  ({
    label,
    detail,
    elapsed,
    status,
    step,
    writing,
    expanded,
    onClick,
  }: AgentHeartbeatProps) => (
    <button
      type="button"
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        onClick();
      }}
      aria-label={`${label}${
        detail ? ` · ${detail}` : ''
      }. View agent activity`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-secondary hover:bg-fill/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:min-h-8"
    >
      <span
        className={
          status === 'failed'
            ? 'text-error'
            : status === 'active' || status === 'retrying'
            ? 'text-primary motion-safe:animate-pulse'
            : 'text-muted'
        }
      >
        <ActivityIcon step={step} status={status} writing={writing} />
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        title={[label, detail].filter(Boolean).join(' · ')}
      >
        {label}
        {detail && <span className="text-muted"> · {detail}</span>}
      </span>
      {elapsed && (
        <span
          aria-hidden="true"
          className="flex-shrink-0 tabular-nums text-muted"
        >
          {elapsed}
        </span>
      )}
      <IconChevronRight
        size={14}
        className="flex-shrink-0"
        aria-hidden="true"
      />
    </button>
  ),
);

AgentHeartbeat.displayName = 'AgentHeartbeat';
