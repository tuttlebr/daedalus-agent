'use client';

import { IconRobot } from '@tabler/icons-react';

interface EmptyStateProps {
  intervalSeconds?: number;
  enabled: boolean;
  filtered: boolean;
}

function formatInterval(seconds?: number): string {
  if (!seconds || seconds <= 0) return 'a few hours';
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? '' : 's'}`;
}

export function EmptyState({ intervalSeconds, enabled, filtered }: EmptyStateProps) {
  if (filtered) {
    return (
      <div className="mx-auto max-w-md py-24 text-center">
        <p className="font-serif text-[17px] italic leading-relaxed text-dark-text-muted">
          Nothing in this lane yet.
        </p>
        <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.18em] text-dark-text-subtle">
          try another filter
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <span className="mb-5 inline-grid h-12 w-12 place-items-center rounded-full bg-white/[0.04] text-dark-text-muted ring-1 ring-white/[0.04]">
        <IconRobot size={22} />
      </span>
      <p className="font-serif text-[18px] leading-relaxed text-dark-text-secondary">
        {enabled
          ? 'Aurora hasn’t surfaced anything yet.'
          : 'Aurora is paused.'}
      </p>
      <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.18em] text-dark-text-subtle">
        {enabled
          ? `next sweep in about ${formatInterval(intervalSeconds)}`
          : 'open the workspace to wake her up'}
      </p>
    </div>
  );
}
