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
      className="app-segmented mb-3"
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
            className="app-segment group shrink-0 px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
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
                'text-[0.75rem] tabular-nums',
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
