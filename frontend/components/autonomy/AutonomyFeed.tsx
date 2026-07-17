'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AutonomyConfig, AutonomyFeedItem } from '@/types/autonomy';

import { DayGroup } from './DayGroup';
import { EmptyState } from './EmptyState';
import { FeedItem } from './FeedItem';
import { LaneFilterChips } from './LaneFilterChips';
import { groupByDay, type LaneFilter, laneOrder, normalizeLane } from './utils';

import { useUISettingsStore } from '@/state';

interface AutonomyFeedProps {
  items: AutonomyFeedItem[];
  config: AutonomyConfig | null;
}

const PAGE_SIZE = 30;

export function AutonomyFeed({ items, config }: AutonomyFeedProps) {
  // Lane filter lives in the persisted UI store so the selection survives
  // switching views (which unmounts this component) and reloads.
  const storedLane = useUISettingsStore((s) => s.autonomyLaneFilter);
  const setLane = useUISettingsStore((s) => s.setAutonomyLaneFilter);
  const lane: LaneFilter = (['all', ...laneOrder()] as string[]).includes(
    storedLane,
  )
    ? (storedLane as LaneFilter)
    : 'all';
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const counts = useMemo(() => {
    const acc: Record<LaneFilter, number> = {
      all: 0,
      known: 0,
      adjacent: 0,
      scout: 0,
    };
    for (const item of items) {
      const l = normalizeLane(item.lane);
      acc.all += 1;
      acc[l] += 1;
    }
    return acc;
  }, [items]);

  const filtered = useMemo(() => {
    if (lane === 'all') return items;
    return items.filter((item) => normalizeLane(item.lane) === lane);
  }, [items, lane]);

  const visibleItems = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );
  const grouped = useMemo(() => groupByDay(visibleItems), [visibleItems]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [lane]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    if (visibleCount >= filtered.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisibleCount((n) => Math.min(filtered.length, n + PAGE_SIZE));
          }
        }
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [filtered.length, visibleCount]);

  const flatIds = useMemo(
    () => visibleItems.map((item) => item.id),
    [visibleItems],
  );

  useEffect(() => {
    if (focusedId && !flatIds.includes(focusedId))
      setFocusedId(flatIds[0] ?? null);
  }, [flatIds, focusedId]);

  const registerRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) itemRefs.current.set(id, el);
    else itemRefs.current.delete(id);
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        target?.isContentEditable
      ) {
        return;
      }
      // Never hijack keys inside open dialogs, and let Enter activate the
      // button or link it is aimed at instead of toggling a feed item.
      if (target?.closest('[role="dialog"]')) return;
      if (event.key === 'Enter' && target?.closest('button, a')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!['j', 'k', 'o', 'Enter'].includes(event.key)) return;
      if (!flatIds.length) return;
      event.preventDefault();
      const currentIndex = focusedId ? flatIds.indexOf(focusedId) : -1;
      if (event.key === 'j') {
        const nextIdx =
          currentIndex < 0 ? 0 : Math.min(flatIds.length - 1, currentIndex + 1);
        focusItem(flatIds[nextIdx]);
      } else if (event.key === 'k') {
        const nextIdx = currentIndex <= 0 ? 0 : currentIndex - 1;
        focusItem(flatIds[nextIdx]);
      } else if (event.key === 'o' || event.key === 'Enter') {
        if (focusedId) toggleExpanded(focusedId);
      }
    }

    function focusItem(id: string | undefined) {
      if (!id) return;
      setFocusedId(id);
      const el = itemRefs.current.get(id);
      if (el) {
        el.focus({ preventScroll: true });
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [flatIds, focusedId, toggleExpanded]);

  if (!items.length) {
    return (
      <EmptyState
        intervalSeconds={config?.intervalSeconds}
        enabled={!!config?.enabled}
        filtered={false}
      />
    );
  }

  return (
    <div>
      <LaneFilterChips value={lane} counts={counts} onChange={setLane} />
      {filtered.length === 0 ? (
        <EmptyState
          intervalSeconds={config?.intervalSeconds}
          enabled={!!config?.enabled}
          filtered
        />
      ) : (
        <div
          role="feed"
          aria-busy={false}
          className="mx-auto max-w-[720px] px-1"
        >
          {grouped.map((bucket, bucketIdx) => {
            let posCounter = grouped
              .slice(0, bucketIdx)
              .reduce((sum, b) => sum + b.items.length, 0);
            return (
              <DayGroup key={bucket.dayStart} label={bucket.label}>
                {bucket.items.map((item) => {
                  posCounter += 1;
                  return (
                    <FeedItem
                      key={item.id}
                      item={item}
                      isExpanded={expandedIds.has(item.id)}
                      onToggle={toggleExpanded}
                      posinset={posCounter}
                      setsize={visibleItems.length}
                      focused={focusedId === item.id}
                      registerRef={registerRef}
                    />
                  );
                })}
              </DayGroup>
            );
          })}
          {visibleCount < filtered.length && (
            <div ref={sentinelRef} className="h-16" aria-hidden />
          )}
          {visibleCount >= filtered.length && filtered.length > PAGE_SIZE && (
            <p className="py-10 text-center font-mono text-[10px] uppercase tracking-[0.24em] text-dark-text-subtle">
              · end of feed ·
            </p>
          )}
        </div>
      )}
    </div>
  );
}
