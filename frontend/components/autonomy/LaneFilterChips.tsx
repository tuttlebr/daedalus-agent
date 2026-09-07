'use client';

import {
  laneAccent,
  LANE_LABELS,
  laneOrder,
  type Lane,
  type LaneFilter,
} from './utils';

import classNames from 'classnames';

interface LaneFilterChipsProps {
  value: LaneFilter;
  counts: Record<LaneFilter, number>;
  onChange: (next: LaneFilter) => void;
}

const FILTERS: LaneFilter[] = ['all', ...laneOrder()];

export function LaneFilterChips({
  value,
  counts,
  onChange,
}: LaneFilterChipsProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Filter by lane"
      className="mx-auto flex max-w-[720px] flex-wrap items-center gap-1 px-1 pb-3"
    >
      {FILTERS.map((filter) => {
        const active = filter === value;
        const label = filter === 'all' ? 'All' : LANE_LABELS[filter as Lane];
        const count = counts[filter] ?? 0;
        const accent = filter === 'all' ? null : laneAccent(filter as Lane);
        return (
          <button
            key={filter}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={(event) => {
              const index = FILTERS.indexOf(filter);
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % FILTERS.length
                  : event.key === 'ArrowLeft'
                  ? (index + FILTERS.length - 1) % FILTERS.length
                  : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                  ? FILTERS.length - 1
                  : -1;
              if (next === -1) return;
              event.preventDefault();
              onChange(FILTERS[next]);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                [next]?.focus();
            }}
            onClick={() => onChange(filter)}
            className={classNames(
              'group inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-[0.75rem] font-medium tracking-wide transition md:min-h-[36px]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40',
              active
                ? 'bg-fill/[0.07] text-dark-text-primary'
                : 'text-dark-text-muted hover:bg-fill/[0.03] hover:text-dark-text-secondary',
            )}
          >
            {accent && (
              <span
                aria-hidden
                className={classNames(
                  'h-1.5 w-1.5 rounded-full',
                  accent.dot,
                  active && accent.glow,
                )}
              />
            )}
            <span>{label}</span>
            <span
              className={classNames(
                'font-mono text-[0.75rem] tabular-nums',
                active ? 'text-dark-text-secondary' : 'text-dark-text-subtle',
              )}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
