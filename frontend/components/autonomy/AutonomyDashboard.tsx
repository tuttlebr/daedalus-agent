'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

export function AutonomyDashboard() {
  const [state, setState] = useState<DashboardState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);
  const titleRestoreRef = useRef<string | null>(null);

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

  const refresh = useCallback(async () => {
    try {
      const [config, goals, runs, queue, feed, approvals] = await Promise.all([
        fetch('/api/autonomy/config').then((r) => r.json()),
        fetch('/api/autonomy/goals').then((r) => r.json()),
        fetch('/api/autonomy/runs').then((r) => r.json()),
        fetch('/api/autonomy/queue').then((r) => r.json()),
        fetch('/api/autonomy/feed').then((r) => r.json()),
        fetch('/api/autonomy/approvals').then((r) => r.json()),
      ]);
      let events: AutonomyEvent[] = [];
      if (runs?.[0]?.id) {
        const detail = await fetch(`/api/autonomy/runs/${runs[0].id}`).then(
          (r) => (r.ok ? r.json() : null),
        );
        events = detail?.events || [];
      }
      setState({ config, goals, runs, queue, feed, approvals, events });
    } finally {
      setLoading(false);
    }
  }, []);

  // TODO: WS callbacks all fan-out to a full refresh today. A future change can
  // route each event to a targeted fetch (only `feed` on feed_updated, etc.).
  const { isConnected: wsConnected } = useWebSocket({
    enabled: true,
    onAutonomyStatus: refresh,
    onAutonomyRunEvent: refresh,
    onAutonomyFeedUpdated: refresh,
    onAutonomyApprovalRequested: refresh,
  });

  useEffect(() => {
    refresh().catch(() => setLoading(false));
    let timer: number | null = null;
    const start = () => {
      stop();
      timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') {
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
      if (document.visibilityState === 'visible') {
        refresh().catch(() => {});
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
  }, [refresh]);

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
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

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

  return (
    <div className="h-full overflow-y-auto bg-[#0a0b0c] text-dark-text-primary">
      <BackgroundGrain />
      <div className="relative mx-auto w-full max-w-[760px] px-4 pt-1 md:px-6 pb-[calc(96px+env(safe-area-inset-bottom))] md:pb-24">
        <StatusStrip
          ref={workspaceButtonRef}
          config={state.config}
          activeRun={activeRun}
          lastRunAt={lastRunAt}
          pendingApprovals={pendingApprovals.length}
          queuedRequests={state.queue.length}
          onOpenWorkspace={() => setDrawerOpen(true)}
          onRefresh={() => refresh()}
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
        onCancelActiveRun={cancelActiveRun}
        onUpdateInterval={updateInterval}
        onCreateGoal={createGoal}
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
