import type { AutonomyFeedItem, AutonomyConfig } from '@/types/autonomy';

export type Lane = 'known' | 'adjacent' | 'scout';
export type LaneFilter = Lane | 'all';

const LANE_ORDER: Lane[] = ['known', 'adjacent', 'scout'];

export const LANE_LABELS: Record<Lane, string> = {
  known: 'Known',
  adjacent: 'Adjacent',
  scout: 'Scout',
};

const LANE_DOT: Record<Lane, string> = {
  known: 'bg-nvidia-green/70',
  adjacent: 'bg-nvidia-teal-light/70',
  scout: 'bg-nvidia-purple-light/70',
};

const LANE_GLOW: Record<Lane, string> = {
  known: 'shadow-[0_0_8px_rgba(118,185,0,0.45)]',
  adjacent: 'shadow-[0_0_8px_rgba(29,187,164,0.45)]',
  scout: 'shadow-[0_0_8px_rgba(180,93,216,0.5)]',
};

export function normalizeLane(raw: string | undefined): Lane {
  if (raw === 'known' || raw === 'adjacent' || raw === 'scout') return raw;
  return 'scout';
}

export function laneAccent(lane: Lane) {
  return { dot: LANE_DOT[lane], glow: LANE_GLOW[lane] };
}

export function laneOrder(): Lane[] {
  return [...LANE_ORDER];
}

const DAY_MS = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface DayBucket {
  dayStart: number;
  label: string;
  items: AutonomyFeedItem[];
}

export function groupByDay(items: AutonomyFeedItem[]): DayBucket[] {
  if (!items.length) return [];
  const byDay = new Map<number, AutonomyFeedItem[]>();
  for (const item of items) {
    const key = startOfDay(item.createdAt);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(item);
    else byDay.set(key, [item]);
  }
  const todayStart = startOfDay(Date.now());
  const buckets: DayBucket[] = [];
  for (const [dayStart, bucket] of byDay.entries()) {
    bucket.sort((a, b) => b.createdAt - a.createdAt);
    buckets.push({
      dayStart,
      label: dayLabel(dayStart, todayStart),
      items: bucket,
    });
  }
  buckets.sort((a, b) => b.dayStart - a.dayStart);
  return buckets;
}

function dayLabel(dayStart: number, todayStart: number): string {
  const daysAgo = Math.round((todayStart - dayStart) / DAY_MS);
  if (daysAgo <= 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  const date = new Date(dayStart);
  if (daysAgo < 7) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date);
  }
  const sameYear = new Date(todayStart).getFullYear() === date.getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

export function timeOfDay(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ts));
}

export function relativeTime(
  ts?: number | null,
  now: number = Date.now(),
): string {
  if (!ts) return 'never';
  const delta = Math.max(0, now - ts);
  if (delta < 45_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  const days = Math.round(delta / 86_400_000);
  if (days < 30) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(ts));
}

export function nextRunCountdown(
  config: AutonomyConfig | null,
  now: number = Date.now(),
): string | null {
  if (!config || !config.enabled) return null;
  const intervalMs = Math.max(1, config.intervalSeconds || 0) * 1000;
  const last = config.lastScheduledRunAt || 0;
  if (!last) return 'soon';
  const due = last + intervalMs;
  const delta = due - now;
  if (delta <= 0) return 'due';
  if (delta < 3_600_000) return `in ${Math.round(delta / 60_000)}m`;
  if (delta < 86_400_000) return `in ${Math.round(delta / 3_600_000)}h`;
  return `in ${Math.round(delta / 86_400_000)}d`;
}
