'use client';

import {
  IconAlertTriangle,
  IconBolt,
  IconCircleCheck,
  IconClock,
  IconExternalLink,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconShieldCheck,
} from '@tabler/icons-react';
import classNames from 'classnames';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { useWebSocket } from '@/hooks/useWebSocket';
import {
  AutonomyApproval,
  AutonomyConfig,
  AutonomyEvent,
  AutonomyFeedItem,
  AutonomyGoal,
  AutonomyRun,
} from '@/types/autonomy';
import { Button, Input, Textarea } from '@/components/primitives';

interface DashboardState {
  config: AutonomyConfig | null;
  goals: AutonomyGoal[];
  runs: AutonomyRun[];
  feed: AutonomyFeedItem[];
  approvals: AutonomyApproval[];
  events: AutonomyEvent[];
}

const emptyState: DashboardState = {
  config: null,
  goals: [],
  runs: [],
  feed: [],
  approvals: [],
  events: [],
};

function fmtTime(value?: number | null): string {
  if (!value) return 'never';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function statusTone(status: string): string {
  if (status === 'completed') return 'text-emerald-400';
  if (status === 'failed' || status === 'cancelled') return 'text-nvidia-red';
  if (status === 'waiting_approval') return 'text-amber-300';
  if (status === 'running') return 'text-nvidia-green';
  return 'text-dark-text-muted';
}

export function AutonomyDashboard() {
  const [state, setState] = useState<DashboardState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [manualPrompt, setManualPrompt] = useState('');
  const [goalTitle, setGoalTitle] = useState('');
  const [goalDescription, setGoalDescription] = useState('');
  const [intervalHours, setIntervalHours] = useState('4');

  const activeRun = useMemo(
    () => state.runs.find((run) => ['running', 'queued', 'waiting_approval'].includes(run.status)),
    [state.runs],
  );
  const pendingApprovals = state.approvals.filter((approval) => approval.status === 'pending');

  const refresh = useCallback(async () => {
    const [config, goals, runs, feed, approvals] = await Promise.all([
      fetch('/api/autonomy/config').then((r) => r.json()),
      fetch('/api/autonomy/goals').then((r) => r.json()),
      fetch('/api/autonomy/runs').then((r) => r.json()),
      fetch('/api/autonomy/feed').then((r) => r.json()),
      fetch('/api/autonomy/approvals').then((r) => r.json()),
    ]);

    let events: AutonomyEvent[] = [];
    if (runs?.[0]?.id) {
      const detail = await fetch(`/api/autonomy/runs/${runs[0].id}`).then((r) =>
        r.ok ? r.json() : null,
      );
      events = detail?.events || [];
    }

    setState({ config, goals, runs, feed, approvals, events });
    setIntervalHours(String(Math.max(1, Math.round((config.intervalSeconds || 14400) / 3600))));
    setLoading(false);
  }, []);

  useWebSocket({
    enabled: true,
    onAutonomyStatus: refresh,
    onAutonomyRunEvent: refresh,
    onAutonomyFeedUpdated: refresh,
    onAutonomyApprovalRequested: refresh,
  });

  useEffect(() => {
    refresh().catch(() => setLoading(false));
    const timer = window.setInterval(() => {
      refresh().catch(() => {});
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const updateConfig = async (patch: Partial<AutonomyConfig>) => {
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
  };

  const enqueueRun = async (body: Record<string, unknown>) => {
    setBusy('run');
    try {
      const response = await fetch('/api/autonomy/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error('Failed to queue run');
      setManualPrompt('');
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const createGoal = async () => {
    if (!goalTitle.trim()) return;
    setBusy('goal');
    try {
      const response = await fetch('/api/autonomy/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: goalTitle,
          description: goalDescription,
        }),
      });
      if (!response.ok) throw new Error('Failed to create goal');
      setGoalTitle('');
      setGoalDescription('');
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const resolveApproval = async (id: string, decision: 'approved' | 'denied') => {
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
  };

  const cancelActiveRun = async () => {
    if (!activeRun) return;
    setBusy('cancel');
    try {
      await fetch(`/api/autonomy/runs/${activeRun.id}/cancel`, { method: 'POST' });
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="h-full overflow-y-auto bg-dark-bg-primary p-6 text-dark-text-muted">
        Loading autonomy state...
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-dark-bg-primary">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 md:px-6">
        <header className="flex flex-col gap-3 border-b border-white/[0.06] pb-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium uppercase text-nvidia-green">
              <IconRobot size={15} />
              Autonomous Worker
            </div>
            <h1 className="mt-1 text-xl font-semibold text-dark-text-primary">
              Autonomy Dashboard
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={state.config?.enabled ? 'secondary' : 'accent'}
              isLoading={busy === 'config'}
              onClick={() => updateConfig({ enabled: !state.config?.enabled })}
              leftIcon={state.config?.enabled ? <IconPlayerStop size={15} /> : <IconPlayerPlay size={15} />}
            >
              {state.config?.enabled ? 'Pause' : 'Resume'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => refresh()}
              leftIcon={<IconRefresh size={15} />}
            >
              Refresh
            </Button>
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-4">
          <Metric label="Status" value={state.config?.enabled ? 'enabled' : 'paused'} icon={<IconBolt size={16} />} />
          <Metric label="Active run" value={activeRun?.status || 'idle'} icon={<IconClock size={16} />} tone={statusTone(activeRun?.status || '')} />
          <Metric label="Pending approvals" value={String(pendingApprovals.length)} icon={<IconShieldCheck size={16} />} />
          <Metric label="Last run" value={fmtTime(state.runs[0]?.completedAt || state.runs[0]?.startedAt)} icon={<IconCircleCheck size={16} />} />
        </section>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
          <div className="space-y-5">
            <section className="rounded-md border border-white/[0.06] bg-dark-bg-secondary/40 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-dark-text-primary">Run Control</h2>
                {activeRun && (
                  <Button
                    size="xs"
                    variant="danger"
                    isLoading={busy === 'cancel'}
                    onClick={cancelActiveRun}
                    leftIcon={<IconPlayerStop size={13} />}
                  >
                    Cancel
                  </Button>
                )}
              </div>
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <Textarea
                  value={manualPrompt}
                  onChange={(event) => setManualPrompt(event.target.value)}
                  placeholder="Optional instruction for the next autonomous run"
                  maxRows={4}
                />
                <Button
                  variant="accent"
                  isLoading={busy === 'run'}
                  onClick={() => enqueueRun({ trigger: 'manual', prompt: manualPrompt })}
                  leftIcon={<IconPlayerPlay size={16} />}
                >
                  Run Now
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="text-xs text-dark-text-muted">
                  Interval hours
                  <Input
                    type="number"
                    min={1}
                    size="sm"
                    className="mt-1 w-28"
                    value={intervalHours}
                    onChange={(event) => setIntervalHours(event.target.value)}
                  />
                </label>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    updateConfig({
                      intervalSeconds: Math.max(1, Number(intervalHours || 4)) * 3600,
                    })
                  }
                >
                  Save Schedule
                </Button>
              </div>
            </section>

            <section className="rounded-md border border-white/[0.06] bg-dark-bg-secondary/40 p-4">
              <h2 className="mb-3 text-sm font-semibold text-dark-text-primary">Feed</h2>
              <div className="space-y-3">
                {state.feed.length === 0 ? (
                  <p className="text-sm text-dark-text-muted">No feed items yet.</p>
                ) : (
                  state.feed.slice(0, 12).map((item) => <FeedItem key={item.id} item={item} />)
                )}
              </div>
            </section>
          </div>

          <div className="space-y-5">
            <section className="rounded-md border border-white/[0.06] bg-dark-bg-secondary/40 p-4">
              <h2 className="mb-3 text-sm font-semibold text-dark-text-primary">Approvals</h2>
              <div className="space-y-3">
                {pendingApprovals.length === 0 ? (
                  <p className="text-sm text-dark-text-muted">No actions are waiting on you.</p>
                ) : (
                  pendingApprovals.map((approval) => (
                    <div key={approval.id} className="rounded-md border border-amber-400/20 bg-amber-400/5 p-3">
                      <div className="flex items-start gap-2">
                        <IconAlertTriangle size={16} className="mt-0.5 text-amber-300" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-dark-text-primary">{approval.action}</p>
                          <p className="mt-1 line-clamp-4 text-xs leading-5 text-dark-text-muted">{approval.reason}</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {approval.authUrl && (
                              <Button
                                size="xs"
                                variant="secondary"
                                onClick={() =>
                                  window.open(
                                    approval.authUrl,
                                    '_blank',
                                    'noopener,noreferrer',
                                  )
                                }
                                leftIcon={<IconExternalLink size={13} />}
                              >
                                Open Auth
                              </Button>
                            )}
                            <Button
                              size="xs"
                              variant="success"
                              isLoading={busy === approval.id}
                              onClick={() => resolveApproval(approval.id, 'approved')}
                            >
                              {approval.actionType === 'oauth_authorization'
                                ? 'Continue'
                                : 'Approve'}
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => resolveApproval(approval.id, 'denied')}
                            >
                              Deny
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-md border border-white/[0.06] bg-dark-bg-secondary/40 p-4">
              <h2 className="mb-3 text-sm font-semibold text-dark-text-primary">Goals</h2>
              <div className="space-y-2">
                <Input
                  size="sm"
                  value={goalTitle}
                  onChange={(event) => setGoalTitle(event.target.value)}
                  placeholder="Goal title"
                />
                <Textarea
                  value={goalDescription}
                  onChange={(event) => setGoalDescription(event.target.value)}
                  placeholder="Goal detail"
                  maxRows={3}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  isLoading={busy === 'goal'}
                  onClick={createGoal}
                  leftIcon={<IconPlus size={15} />}
                >
                  Add Goal
                </Button>
              </div>
              <div className="mt-4 space-y-2">
                {state.goals.length === 0 ? (
                  <p className="text-sm text-dark-text-muted">No active goals.</p>
                ) : (
                  state.goals.slice(0, 8).map((goal) => (
                    <div key={goal.id} className="border-t border-white/[0.06] pt-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-dark-text-primary">{goal.title}</p>
                          {goal.description && (
                            <p className="mt-0.5 line-clamp-2 text-xs text-dark-text-muted">{goal.description}</p>
                          )}
                        </div>
                        <span className="text-xs text-dark-text-muted">{goal.status}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-md border border-white/[0.06] bg-dark-bg-secondary/40 p-4">
              <h2 className="mb-3 text-sm font-semibold text-dark-text-primary">Recent Runs</h2>
              <div className="space-y-2">
                {state.runs.slice(0, 8).map((run) => (
                  <div key={run.id} className="border-t border-white/[0.06] pt-2 first:border-t-0 first:pt-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className={classNames('text-xs font-medium', statusTone(run.status))}>{run.status}</span>
                      <span className="text-xs text-dark-text-muted">{fmtTime(run.startedAt || run.createdAt)}</span>
                    </div>
                    {run.summary && <p className="mt-1 line-clamp-2 text-xs leading-5 text-dark-text-muted">{run.summary}</p>}
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-md border border-white/[0.06] bg-dark-bg-secondary/40 p-4">
              <h2 className="mb-3 text-sm font-semibold text-dark-text-primary">Latest Events</h2>
              <div className="space-y-2">
                {state.events.slice(0, 10).map((event) => (
                  <div key={event.id} className="flex gap-2 text-xs">
                    <span className="w-20 shrink-0 text-dark-text-muted">{fmtTime(event.createdAt)}</span>
                    <span className={classNames('shrink-0', event.level === 'error' ? 'text-nvidia-red' : event.level === 'warn' ? 'text-amber-300' : 'text-nvidia-green')}>
                      {event.type}
                    </span>
                    <span className="min-w-0 text-dark-text-muted">{event.message}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </section>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  icon,
  tone = 'text-dark-text-primary',
}: {
  label: string;
  value: string;
  icon: ReactNode;
  tone?: string;
}) {
  return (
    <div className="rounded-md border border-white/[0.06] bg-dark-bg-secondary/40 p-3">
      <div className="flex items-center gap-2 text-xs text-dark-text-muted">
        {icon}
        {label}
      </div>
      <div className={classNames('mt-2 truncate text-lg font-semibold', tone)}>{value}</div>
    </div>
  );
}

function FeedItem({ item }: { item: AutonomyFeedItem }) {
  return (
    <article className="rounded-md border border-white/[0.06] bg-black/20 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded border border-nvidia-green/30 px-2 py-0.5 text-[10px] font-semibold uppercase text-nvidia-green">
          {item.lane}
        </span>
        <span className="text-xs text-dark-text-muted">{item.confidence}</span>
      </div>
      <h3 className="text-sm font-semibold text-dark-text-primary">{item.title}</h3>
      <p className="mt-1 text-sm font-medium leading-5 text-white">{item.bluf}</p>
      {item.body && <p className="mt-2 text-sm leading-6 text-dark-text-secondary">{item.body}</p>}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-dark-text-muted">
        {item.sourceUrl && (
          <a className="text-nvidia-green hover:text-nvidia-green-light" href={item.sourceUrl} target="_blank" rel="noreferrer">
            Source
          </a>
        )}
        {item.confidenceReason && <span>{item.confidenceReason}</span>}
      </div>
    </article>
  );
}
