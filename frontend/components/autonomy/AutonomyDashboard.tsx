'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import toast from 'react-hot-toast';

import { useWebSocket } from '@/hooks/useWebSocket';

import type {
  AutonomyApproval,
  AutonomyConfig,
  AutonomyEvent,
  AutonomyFeedItem,
  AutonomyGoal,
  AutonomyQueuedRequest,
  AutonomyRun,
} from '@/types/autonomy';

import { ApprovalBanner } from './ApprovalBanner';
import { AutonomyFeed } from './AutonomyFeed';
import { StatusStrip } from './StatusStrip';
import { WorkspaceDrawer } from './WorkspaceDrawer';

interface DashboardState {
  config: AutonomyConfig | null;
  goals: AutonomyGoal[];
  runs: AutonomyRun[];
  queue: AutonomyQueuedRequest[];
  feed: AutonomyFeedItem[];
  approvals: AutonomyApproval[];
  events: AutonomyEvent[];
}

const emptyState: DashboardState = {
  config: null,
  goals: [],
  runs: [],
  queue: [],
  feed: [],
  approvals: [],
  events: [],
};

const POLL_INTERVAL_MS = 15_000;
const WS_REFRESH_DEBOUNCE_MS = 50;

type DashboardResource =
  | 'config'
  | 'goals'
  | 'runs'
  | 'queue'
  | 'feed'
  | 'approvals'
  | 'events';

const ALL_RESOURCES: readonly DashboardResource[] = [
  'config',
  'goals',
  'runs',
  'queue',
  'feed',
  'approvals',
  'events',
];

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to refresh ${url}`);
  return response.json() as Promise<T>;
}

export function AutonomyDashboard() {
  const [state, setState] = useState<DashboardState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);
  const titleRestoreRef = useRef<string | null>(null);
  const stateRef = useRef(state);
  const pendingResourcesRef = useRef<Set<DashboardResource>>(new Set());
  const scheduledRefreshRef = useRef<number | null>(null);
  const latestEventRunIdRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);

  const activeRun = useMemo(
    () =>
      state.runs.find((run) =>
        ['running', 'queued', 'waiting_approval'].includes(run.status),
      ),
    [state.runs],
  );
  const pendingApprovals = useMemo(
    () => state.approvals.filter((approval) => approval.status === 'pending'),
    [state.approvals],
  );
  const feedSorted = useMemo(
    () => [...state.feed].sort((a, b) => b.createdAt - a.createdAt),
    [state.feed],
  );
  const lastRunAt = useMemo(() => {
    if (!state.runs.length) return null;
    const r = state.runs[0];
    return r.completedAt || r.startedAt || r.createdAt || null;
  }, [state.runs]);

  const refreshResources = useCallback(
    async (
      resources: readonly DashboardResource[],
      eventRunId?: string | null,
    ) => {
      const requested = new Set(resources);
      const [config, goals, runs, queue, feed, approvals] = await Promise.all([
        requested.has('config')
          ? fetchJson<AutonomyConfig>('/api/autonomy/config')
          : undefined,
        requested.has('goals')
          ? fetchJson<AutonomyGoal[]>('/api/autonomy/goals')
          : undefined,
        requested.has('runs')
          ? fetchJson<AutonomyRun[]>('/api/autonomy/runs')
          : undefined,
        requested.has('queue')
          ? fetchJson<AutonomyQueuedRequest[]>('/api/autonomy/queue')
          : undefined,
        requested.has('feed')
          ? fetchJson<AutonomyFeedItem[]>('/api/autonomy/feed')
          : undefined,
        requested.has('approvals')
          ? fetchJson<AutonomyApproval[]>('/api/autonomy/approvals')
          : undefined,
      ]);

      const patch: Partial<DashboardState> = {};
      if (config !== undefined) patch.config = config;
      if (goals !== undefined) patch.goals = goals;
      if (runs !== undefined) patch.runs = runs;
      if (queue !== undefined) patch.queue = queue;
      if (feed !== undefined) patch.feed = feed;
      if (approvals !== undefined) patch.approvals = approvals;

      if (requested.has('events')) {
        const currentRuns = runs ?? stateRef.current.runs;
        const runId = currentRuns[0]?.id || eventRunId;
        if (runId) {
          const detail = await fetchJson<{ events?: AutonomyEvent[] }>(
            `/api/autonomy/runs/${encodeURIComponent(runId)}`,
          );
          patch.events = detail.events || [];
        } else {
          patch.events = [];
        }
      }

      setState((current) => {
        const next = { ...current, ...patch };
        stateRef.current = next;
        return next;
      });
    },
    [],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshResources(ALL_RESOURCES);
      setLoadError(false);
    } catch (err) {
      // Surface load failures instead of silently rendering an empty feed.
      console.error('Failed to refresh autonomy dashboard:', err);
      setLoadError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [refreshResources]);

  const scheduleRefresh = useCallback(
    (resources: readonly DashboardResource[], eventRunId?: string | null) => {
      resources.forEach((resource) =>
        pendingResourcesRef.current.add(resource),
      );
      if (eventRunId) latestEventRunIdRef.current = eventRunId;
      if (scheduledRefreshRef.current !== null) return;

      scheduledRefreshRef.current = window.setTimeout(() => {
        scheduledRefreshRef.current = null;
        const pending = Array.from(pendingResourcesRef.current);
        pendingResourcesRef.current.clear();
        const latestEventRunId = latestEventRunIdRef.current;
        latestEventRunIdRef.current = null;
        refreshResources(pending, latestEventRunId).catch(() => {});
      }, WS_REFRESH_DEBOUNCE_MS);
    },
    [refreshResources],
  );

  const handleAutonomyStatus = useCallback(
    (data: Record<string, unknown> | null | undefined) => {
      const resources: DashboardResource[] = [];
      if (data?.config) resources.push('config');
      if (data?.goals) resources.push('goals');
      if (data?.run || data?.runId || data?.status) resources.push('runs');
      if (data?.queued || data?.queuedBatch) resources.push('queue');
      if (data?.approval) resources.push('approvals');
      scheduleRefresh(resources.length ? resources : ALL_RESOURCES);
    },
    [scheduleRefresh],
  );

  const { isConnected: wsConnected } = useWebSocket({
    enabled: true,
    onAutonomyStatus: handleAutonomyStatus,
    onAutonomyRunEvent: (event) =>
      scheduleRefresh(['runs', 'events'], event?.runId),
    onAutonomyFeedUpdated: () => scheduleRefresh(['feed']),
    onAutonomyApprovalRequested: () => scheduleRefresh(['approvals']),
    onConnected: () => {
      if (hasConnectedRef.current) scheduleRefresh(ALL_RESOURCES);
      hasConnectedRef.current = true;
    },
    onDisconnected: () => {
      hasConnectedRef.current = true;
      scheduleRefresh(ALL_RESOURCES);
    },
  });

  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    let timer: number | null = null;
    const start = () => {
      stop();
      if (wsConnected || document.visibilityState !== 'visible') return;
      timer = window.setInterval(() => {
        if (!wsConnected && document.visibilityState === 'visible') {
          refresh().catch(() => {});
        }
      }, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !wsConnected) {
        scheduleRefresh(ALL_RESOURCES);
        start();
      } else {
        stop();
      }
    };
    start();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refresh, scheduleRefresh, wsConnected]);

  useEffect(
    () => () => {
      if (scheduledRefreshRef.current !== null) {
        window.clearTimeout(scheduledRefreshRef.current);
      }
    },
    [],
  );

  // Document title alert when approvals are pending and tab is unfocused
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (titleRestoreRef.current === null)
      titleRestoreRef.current = document.title;
    const baseTitle = titleRestoreRef.current
      .replace(/^\(\d+\)\s+/, '')
      .replace(/\s+— Pending$/, '');
    const updateTitle = () => {
      const hidden = document.visibilityState !== 'visible';
      if (hidden && pendingApprovals.length > 0) {
        document.title = `(${pendingApprovals.length}) ${baseTitle} — Pending`;
      } else {
        document.title = baseTitle;
      }
    };
    updateTitle();
    document.addEventListener('visibilitychange', updateTitle);
    window.addEventListener('focus', updateTitle);
    return () => {
      document.removeEventListener('visibilitychange', updateTitle);
      window.removeEventListener('focus', updateTitle);
      document.title = baseTitle;
    };
  }, [pendingApprovals.length]);

  const updateConfig = useCallback(
    async (patch: Partial<AutonomyConfig>) => {
      setBusy('config');
      try {
        const response = await fetch('/api/autonomy/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!response.ok) throw new Error('Failed to update config');
        await refresh();
      } catch (err) {
        console.error(err);
        toast.error('Could not update the autonomy settings. Try again.');
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const enqueueRun = useCallback(
    async (prompt: string) => {
      setBusy('run');
      try {
        const response = await fetch('/api/autonomy/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trigger: 'manual', prompt }),
        });
        if (!response.ok) throw new Error('Failed to queue run');
        await refresh();
      } catch (err) {
        console.error(err);
        toast.error('Could not queue the run. Try again.');
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const runActiveGoals = useCallback(
    async (prompt: string) => {
      setBusy('run:goals');
      try {
        const response = await fetch('/api/autonomy/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'all_active_goals', prompt }),
        });
        if (!response.ok) throw new Error('Failed to queue active goals');
        await refresh();
      } catch (err) {
        console.error(err);
        toast.error('Could not run the active goals. Try again.');
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const createGoal = useCallback(
    async (title: string, description: string) => {
      if (!title.trim()) return;
      setBusy('goal');
      try {
        const response = await fetch('/api/autonomy/goals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description }),
        });
        if (!response.ok) throw new Error('Failed to create goal');
        await refresh();
      } catch (err) {
        console.error(err);
        toast.error('Could not create the goal. Try again.');
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const importGoals = useCallback(
    async (payload: unknown) => {
      setBusy('goal:import');
      try {
        const body =
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? { mode: 'replace', ...payload }
            : { mode: 'replace', goals: payload };
        const response = await fetch('/api/autonomy/goals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error('Failed to import goals');
        await refresh();
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const importProfile = useCallback(async (payload: unknown) => {
    setBusy('profile:import');
    try {
      const response = await fetch('/api/profile/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(
          errorBody?.detail ||
            errorBody?.error ||
            `Failed to import profile (${response.status})`,
        );
      }
    } finally {
      setBusy(null);
    }
  }, []);

  const deleteGoal = useCallback(
    async (id: string) => {
      setBusy(`goal:${id}`);
      try {
        const response = await fetch(
          `/api/autonomy/goals?id=${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        );
        if (!response.ok) throw new Error('Failed to delete goal');
        await refresh();
      } catch (err) {
        console.error(err);
        toast.error('Could not delete the goal. Try again.');
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const resolveApproval = useCallback(
    async (id: string, decision: 'approved' | 'denied') => {
      setBusy(id);
      try {
        const response = await fetch('/api/autonomy/approvals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, decision }),
        });
        if (!response.ok) throw new Error('Failed to resolve approval');
        await refresh();
      } catch (err) {
        console.error(err);
        toast.error(
          decision === 'approved'
            ? 'Could not approve the request. It is still pending.'
            : 'Could not deny the request. It is still pending.',
        );
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const cancelActiveRun = useCallback(async () => {
    if (!activeRun) return;
    setBusy('cancel');
    try {
      await fetch(`/api/autonomy/runs/${activeRun.id}/cancel`, {
        method: 'POST',
      });
      await refresh();
    } catch (err) {
      console.error(err);
      toast.error('Could not cancel the run. Try again.');
    } finally {
      setBusy(null);
    }
  }, [activeRun, refresh]);

  const togglePause = useCallback(() => {
    void updateConfig({ enabled: !state.config?.enabled });
  }, [state.config?.enabled, updateConfig]);

  const updateInterval = useCallback(
    (hours: number) => {
      void updateConfig({ intervalSeconds: Math.max(1, hours) * 3600 });
    },
    [updateConfig],
  );

  const handleDrawerClose = useCallback(() => {
    setDrawerOpen(false);
    window.setTimeout(() => workspaceButtonRef.current?.focus(), 80);
  }, []);

  if (loading) {
    return (
      <div className="h-full overflow-y-auto bg-[#0a0b0c]">
        <div className="mx-auto max-w-[720px] px-4 py-12 md:px-6">
          <SkeletonFeed />
        </div>
      </div>
    );
  }

  // A failed first load must not masquerade as an empty feed.
  if (loadError && !state.config && state.feed.length === 0) {
    return (
      <div className="h-full overflow-y-auto bg-[#0a0b0c] text-dark-text-primary">
        <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-4 px-4 text-center">
          <p className="text-sm text-dark-text-secondary">
            Could not load the autonomy dashboard. Check your connection and try
            again.
          </p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void refresh();
            }}
            className="min-h-touch-min rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-2 text-sm text-dark-text-primary transition-colors hover:border-nvidia-green/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-[#0a0b0c] text-dark-text-primary">
      <BackgroundGrain />
      <div className="relative mx-auto w-full max-w-[760px] px-4 pt-1 pb-8 md:px-6">
        <StatusStrip
          ref={workspaceButtonRef}
          config={state.config}
          activeRun={activeRun}
          lastRunAt={lastRunAt}
          pendingApprovals={pendingApprovals.length}
          queuedRequests={state.queue.length}
          onOpenWorkspace={() => setDrawerOpen(true)}
          onRefresh={() => refresh()}
          refreshing={refreshing}
          wsConnected={wsConnected}
        />
        <ApprovalBanner
          approvals={pendingApprovals}
          busyId={busy}
          onResolve={resolveApproval}
        />
        <AutonomyFeed items={feedSorted} config={state.config} />
      </div>
      <WorkspaceDrawer
        open={drawerOpen}
        onClose={handleDrawerClose}
        config={state.config}
        goals={state.goals}
        runs={state.runs}
        queue={state.queue}
        events={state.events}
        activeRun={activeRun}
        busy={busy}
        onTogglePause={togglePause}
        onEnqueueRun={enqueueRun}
        onRunActiveGoals={runActiveGoals}
        onCancelActiveRun={cancelActiveRun}
        onUpdateInterval={updateInterval}
        onCreateGoal={createGoal}
        onImportGoals={importGoals}
        onImportProfile={importProfile}
        onDeleteGoal={deleteGoal}
      />
    </div>
  );
}

function BackgroundGrain() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 opacity-[0.025] mix-blend-overlay"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.7'/></svg>\")",
      }}
    />
  );
}

function SkeletonFeed() {
  return (
    <div className="space-y-8">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="h-3 w-20 animate-pulse rounded bg-white/[0.04]" />
          <div className="h-5 w-3/4 animate-pulse rounded bg-white/[0.06]" />
          <div className="h-4 w-full animate-pulse rounded bg-white/[0.04]" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-white/[0.03]" />
        </div>
      ))}
    </div>
  );
}
