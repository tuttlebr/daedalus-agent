'use client';

import { IconArrowUpRight, IconChevronRight } from '@tabler/icons-react';
import classNames from 'classnames';
import { memo } from 'react';

import type { AutonomyFeedItem } from '@/types/autonomy';

import { laneAccent, LANE_LABELS, normalizeLane, timeOfDay } from './utils';

interface FeedItemProps {
  item: AutonomyFeedItem;
  isExpanded: boolean;
  onToggle: (id: string) => void;
  posinset: number;
  setsize: number;
  focused: boolean;
  registerRef: (id: string, el: HTMLElement | null) => void;
}

function FeedItemImpl({
  item,
  isExpanded,
  onToggle,
  posinset,
  setsize,
  focused,
  registerRef,
}: FeedItemProps) {
  const lane = normalizeLane(item.lane);
  const accent = laneAccent(lane);
  const hasBody = !!item.body && item.body.trim().length > 0;
  const expanded = isExpanded && hasBody;

  return (
    <article
      ref={(el) => registerRef(item.id, el)}
      role="article"
      tabIndex={-1}
      aria-posinset={posinset}
      aria-setsize={setsize}
      data-focused={focused}
      className={classNames(
        'group relative pl-7 outline-none transition-colors duration-200',
        'before:absolute before:left-[-5px] before:top-[7px] before:h-2.5 before:w-2.5 before:rounded-full before:transition-all',
        focused ? 'before:scale-110' : '',
        focused && 'before:ring-2 before:ring-white/30',
      )}
    >
      <span
        aria-hidden
        className={classNames(
          'absolute left-[-5px] top-[7px] h-2.5 w-2.5 rounded-full',
          accent.dot,
          'group-hover:scale-110 transition-transform',
        )}
      />
      <span
        aria-hidden
        className={classNames(
          'absolute left-[-5px] top-[7px] h-2.5 w-2.5 rounded-full opacity-0 transition-opacity duration-300',
          accent.glow,
          'group-hover:opacity-100',
          focused && 'opacity-100',
        )}
      />

      <header className="flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-dark-text-subtle">
        <span className="text-dark-text-muted">{LANE_LABELS[lane]}</span>
        <span>·</span>
        <time dateTime={new Date(item.createdAt).toISOString()}>{timeOfDay(item.createdAt)}</time>
        {item.confidence && item.confidence !== 'high' && (
          <>
            <span>·</span>
            <span title={item.confidenceReason || undefined}>{item.confidence}</span>
          </>
        )}
      </header>

      <button
        type="button"
        onClick={() => hasBody && onToggle(item.id)}
        className={classNames(
          'mt-1 block w-full text-left font-display text-[17px] font-semibold leading-snug tracking-[-0.005em] text-dark-text-primary',
          'transition-colors duration-150',
          hasBody && 'cursor-pointer hover:text-white',
          !hasBody && 'cursor-default',
          'focus-visible:outline-none focus-visible:underline focus-visible:decoration-nvidia-green/40 focus-visible:underline-offset-4',
        )}
        aria-expanded={hasBody ? expanded : undefined}
        aria-controls={hasBody ? `feed-body-${item.id}` : undefined}
      >
        {item.title}
      </button>

      <p className="mt-1.5 font-serif text-[15px] leading-[1.65] text-dark-text-secondary">
        {item.bluf}
      </p>

      {hasBody && (
        <div
          id={`feed-body-${item.id}`}
          className={classNames(
            'grid overflow-hidden transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none',
            expanded ? 'mt-3 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-70',
          )}
        >
          <div className="min-h-0">
            <p className="whitespace-pre-line border-l border-white/[0.05] pl-3 font-serif text-[15px] leading-[1.7] text-dark-text-secondary">
              {item.body}
            </p>
          </div>
        </div>
      )}

      <footer className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-dark-text-subtle">
        {hasBody && (
          <button
            type="button"
            onClick={() => onToggle(item.id)}
            className={classNames(
              'inline-flex items-center gap-0.5 text-dark-text-muted transition hover:text-dark-text-primary',
              'focus-visible:outline-none focus-visible:text-dark-text-primary',
            )}
          >
            <IconChevronRight
              size={12}
              className={classNames('transition-transform', expanded && 'rotate-90')}
            />
            <span>{expanded ? 'collapse' : 'read more'}</span>
          </button>
        )}
        {item.sourceUrl && (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-0.5 text-nvidia-green/80 transition hover:text-nvidia-green focus-visible:outline-none focus-visible:text-nvidia-green"
          >
            <span>source</span>
            <IconArrowUpRight size={11} />
          </a>
        )}
        {expanded && item.confidenceReason && (
          <span className="italic text-dark-text-subtle">{item.confidenceReason}</span>
        )}
      </footer>
    </article>
  );
}

export const FeedItem = memo(FeedItemImpl);
