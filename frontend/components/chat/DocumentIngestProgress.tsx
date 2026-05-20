'use client';

import { memo } from 'react';
import classNames from 'classnames';
import {
  IconAlertCircle,
  IconCheck,
  IconDatabase,
  IconFileText,
  IconLoader2,
} from '@tabler/icons-react';
import { ProgressBar } from '@/components/primitives';

export interface DocumentIngestProgressData {
  completed: number;
  total: number;
  currentDoc?: string;
  currentIndex?: number;
  percent: number;
  phase?: string;
  message?: string;
  chunks?: number;
  pages?: number;
  failures?: number;
  attempt?: number;
}

interface DocumentIngestProgressProps {
  progress: DocumentIngestProgressData;
  className?: string;
}

function truncateMiddle(value: string, max = 48): string {
  if (value.length <= max) return value;
  const keep = Math.max(0, Math.floor((max - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

const phaseLabels: Record<string, string> = {
  queued: 'Queued',
  fetching: 'Fetching upload',
  fetched: 'Fetched upload',
  waiting: 'Waiting for collection',
  preparing: 'Preparing pipeline',
  submitting: 'Submitting to NV-Ingest',
  processing: 'Extracting and embedding',
  indexing: 'Writing to Milvus',
  postprocessing: 'Post-processing',
  postprocessed: 'Post-processing complete',
  retrying: 'Retrying',
  skipped: 'Skipped remaining files',
  failed: 'Failed',
  finalizing: 'Finalizing',
  completed: 'Indexed',
};

export const DocumentIngestProgress = memo(({
  progress,
  className = '',
}: DocumentIngestProgressProps) => {
  const {
    completed,
    total,
    currentDoc,
    currentIndex,
    percent,
    phase = completed >= total && total > 0 ? 'completed' : 'queued',
    message,
    chunks,
    pages,
    failures,
  } = progress;
  const safeTotal = Math.max(total, 1);
  const finished = phase === 'completed' && completed >= total && total > 0;
  const errored = phase === 'failed';
  const indeterminate = percent <= 0 && !finished && !errored;
  const noun = total === 1 ? 'document' : 'documents';
  const activeName = currentDoc ? truncateMiddle(currentDoc) : null;
  const phaseLabel = phaseLabels[phase] || 'Processing';

  const heading = finished
    ? `Indexed ${total} ${noun}`
    : `Ingesting ${total} ${noun}`;

  const detail = message
    || (activeName ? `${phaseLabel}: ${activeName}` : phaseLabel);
  const docCounter = currentIndex && !finished
    ? `Doc ${currentIndex}/${safeTotal}`
    : `${completed}/${safeTotal}`;
  const metrics = [
    chunks !== undefined ? `${chunks} chunks` : null,
    pages !== undefined ? `${pages} pages` : null,
    failures ? `${failures} failures` : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <div
      className={classNames(
        'rounded-lg border border-white/[0.08] bg-dark-bg-secondary/80 px-4 py-3 shadow-sm',
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <div
          className={classNames(
            'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full',
            errored
              ? 'bg-nvidia-red/15 text-nvidia-red'
              : finished
                ? 'bg-nvidia-teal/15 text-nvidia-teal'
                : phase === 'indexing'
                  ? 'bg-nvidia-teal/15 text-nvidia-teal'
                  : 'bg-nvidia-green/15 text-nvidia-green',
          )}
        >
          {errored ? (
            <IconAlertCircle size={16} />
          ) : finished ? (
            <IconCheck size={16} />
          ) : phase === 'indexing' ? (
            <IconDatabase size={16} />
          ) : phase === 'processing' || phase === 'postprocessing' ? (
            <IconLoader2 size={16} className="animate-spin" />
          ) : (
            <IconFileText size={16} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium text-dark-text-primary">
              {heading}
            </span>
            <span className="flex-shrink-0 font-mono text-xs text-dark-text-muted">
              {indeterminate
                ? docCounter
                : `${docCounter} · ${Math.round(percent)}%`}
            </span>
          </div>
          <div className="mt-1 truncate text-xs text-dark-text-muted">
            {detail}
          </div>
          {metrics.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-dark-text-muted">
              {metrics.map((item) => (
                <span
                  key={item}
                  className="rounded-md bg-white/[0.04] px-2 py-0.5"
                >
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <ProgressBar
        value={percent}
        size="sm"
        variant={errored ? 'error' : finished ? 'success' : 'accent'}
        indeterminate={indeterminate}
        className="mt-3"
      />
    </div>
  );
});

DocumentIngestProgress.displayName = 'DocumentIngestProgress';
