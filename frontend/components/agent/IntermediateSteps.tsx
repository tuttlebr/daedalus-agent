import { IconX } from '@tabler/icons-react';
import React, { useState, useMemo, useEffect } from 'react';

import {
  consolidateSteps,
  flattenSteps,
  normalizeSteps,
  OPERATION_LABELS,
  type OperationStatus,
} from '@/utils/app/intermediateSteps';

import { IntermediateStepCategory } from '@/types/intermediateSteps';

import { AgentHeartbeat } from '@/components/chat/AgentHeartbeat';
import { ModalSurface } from '@/components/surfaces';

import { StepTimeline } from './StepTimeline';
import { ViewToggle } from './ViewToggle';

export interface ActivityProgress {
  status?: 'pending' | 'streaming' | 'oauth_required' | 'completed' | 'error';
  startedAt?: number;
  updatedAt?: number;
  text?: string;
}

interface IntermediateStepsProps {
  steps: any[];
  className?: string;
  isStreaming?: boolean;
  durationMs?: number;
  hasError?: boolean;
  stopped?: boolean;
  progress?: ActivityProgress;
}

export function formatActivityElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(
    (seconds % 3600) / 60,
  )}m ${seconds % 60}s`;
}

export const IntermediateSteps: React.FC<IntermediateStepsProps> = ({
  steps,
  className = '',
  isStreaming = false,
  durationMs,
  hasError = false,
  stopped = false,
  progress,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [mountedAt] = useState(Date.now);
  const normalized = useMemo(() => normalizeSteps(steps), [steps]);
  const operations = useMemo(
    () => flattenSteps(consolidateSteps(normalized, !isStreaming)),
    [normalized, isStreaming],
  );
  const tools = operations.filter(
    (step) => step.category === IntermediateStepCategory.TOOL,
  );
  const activeTools = tools.filter((step) =>
    ['active', 'retrying', 'waiting', 'queued'].includes(step.status),
  );
  const current =
    activeTools[0] ||
    [...operations].reverse().find((step) => step.status === 'active');
  const writing =
    isStreaming &&
    activeTools.length === 0 &&
    progress?.text === 'Generating response';
  const waiting = isStreaming && progress?.status === 'oauth_required';
  const queued =
    isStreaming && progress?.status === 'pending' && operations.length === 0;
  const unfinished = operations.some((step) => step.status === 'interrupted');
  const failedTools = tools.filter((step) => step.status === 'failed').length;
  let status: OperationStatus = isStreaming
    ? current?.status || 'active'
    : 'completed';
  let label = writing
    ? 'Preparing the answer'
    : current?.friendlyName ||
      (operations.length
        ? 'Preparing next step'
        : progress?.text || 'Thinking');
  if (
    isStreaming &&
    current &&
    ['waiting', 'queued', 'retrying'].includes(current.status)
  )
    label = `${OPERATION_LABELS[current.status]} · ${current.friendlyName}`;
  if (waiting) {
    status = 'waiting';
    label = 'Waiting for authorization';
  } else if (queued) {
    status = 'queued';
    label = 'Queued';
  } else if (isStreaming && activeTools.length > 1) {
    label = `${activeTools.length} tools in progress`;
  } else if (!isStreaming) {
    status = stopped
      ? 'interrupted'
      : hasError
      ? 'failed'
      : unfinished
      ? 'interrupted'
      : 'completed';
    label = stopped
      ? 'Stopped'
      : hasError
      ? 'Response interrupted'
      : unfinished
      ? 'Finished with interrupted activity'
      : 'Completed';
    if (
      typeof durationMs === 'number' &&
      Number.isFinite(durationMs) &&
      durationMs >= 0
    )
      label += ` in ${formatActivityElapsed(durationMs)}`;
  }
  const timestamps = normalized
    .map((step) => step.payload.event_timestamp * 1000)
    .filter(Number.isFinite);
  const startedAt =
    progress?.startedAt ??
    (timestamps.length
      ? timestamps.reduce(
          (earliest, timestamp) => Math.min(earliest, timestamp),
          Infinity,
        )
      : mountedAt);
  const updatedAt = timestamps.reduce(
    (latest, timestamp) => Math.max(latest, timestamp),
    progress?.updatedAt || startedAt,
  );
  const idleSeconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  const toolCount = `${tools.length} tool call${tools.length === 1 ? '' : 's'}`;
  const detail = isStreaming
    ? idleSeconds >= 10 && !waiting && !queued
      ? `last update ${idleSeconds}s ago`
      : activeTools.length === 1 && current?.status === 'active'
      ? '1 tool running'
      : failedTools
      ? `${failedTools} tool${failedTools === 1 ? '' : 's'} failed · continuing`
      : undefined
    : [
        tools.length ? toolCount : undefined,
        failedTools ? `${failedTools} failed` : undefined,
      ]
        .filter(Boolean)
        .join(' · ');

  useEffect(() => {
    if (!isStreaming) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isStreaming]);

  // Announce semantic changes, never the elapsed timer or freshness countdown.
  const announcement = `${label}${
    !isStreaming && detail ? ` · ${detail}` : ''
  }`;

  return (
    <div className={`w-full min-w-0 ${className}`}>
      <AgentHeartbeat
        label={label}
        detail={detail}
        elapsed={
          isStreaming ? formatActivityElapsed(now - startedAt) : undefined
        }
        status={status}
        step={current}
        writing={writing}
        expanded={isExpanded}
        onClick={() => setIsExpanded(true)}
      />
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>
      <ModalSurface
        open={isExpanded}
        onClose={() => setIsExpanded(false)}
        aria-label="Agent activity"
        className="flex max-h-[80dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-separator bg-panel"
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-separator/70 px-4 py-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-primary">
              Agent activity
            </h3>
            <p className="truncate text-xs text-muted">
              {label}
              {tools.length ? ` · ${toolCount}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsExpanded(false)}
            aria-label="Close agent activity"
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg text-muted hover:bg-fill/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <IconX size={18} aria-hidden="true" />
          </button>
        </div>
        <ViewToggle searchTerm={searchTerm} onSearchChange={setSearchTerm} />
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <StepTimeline
            steps={normalized}
            isStreaming={isStreaming}
            searchTerm={searchTerm}
          />
        </div>
      </ModalSurface>
    </div>
  );
};
