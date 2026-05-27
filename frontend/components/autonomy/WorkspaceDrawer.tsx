'use client';

import {
  IconChevronDown,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconX,
} from '@tabler/icons-react';
import classNames from 'classnames';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Input, Textarea } from '@/components/primitives';
import type {
  AutonomyConfig,
  AutonomyEvent,
  AutonomyGoal,
  AutonomyRun,
} from '@/types/autonomy';

import { relativeTime } from './utils';

interface WorkspaceDrawerProps {
  open: boolean;
  onClose: () => void;
  config: AutonomyConfig | null;
  goals: AutonomyGoal[];
  runs: AutonomyRun[];
  events: AutonomyEvent[];
  activeRun: AutonomyRun | undefined;
  busy: string | null;
  onTogglePause: () => void;
  onEnqueueRun: (prompt: string) => void;
  onCancelActiveRun: () => void;
  onUpdateInterval: (hours: number) => void;
  onCreateGoal: (title: string, description: string) => void;
}

export function WorkspaceDrawer({
  open,
  onClose,
  config,
  goals,
  runs,
  events,
  activeRun,
  busy,
  onTogglePause,
  onEnqueueRun,
  onCancelActiveRun,
  onUpdateInterval,
  onCreateGoal,
}: WorkspaceDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [manualPrompt, setManualPrompt] = useState('');
  const [intervalHours, setIntervalHours] = useState('4');
  const [goalTitle, setGoalTitle] = useState('');
  const [goalDescription, setGoalDescription] = useState('');

  useEffect(() => {
    if (!config) return;
    setIntervalHours(String(Math.max(1, Math.round((config.intervalSeconds || 14400) / 3600))));
  }, [config?.intervalSeconds, config]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"]), summary',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>('button, [href], input, textarea')?.focus();
    }, 80);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(timer);
    };
  }, [open, handleKeyDown]);

  const enabled = !!config?.enabled;
  const hasActiveRun = !!activeRun && ['running', 'queued', 'waiting_approval'].includes(activeRun.status);

  return (
    <div
      className={classNames(
        'pointer-events-none fixed inset-0 z-50',
        open && 'pointer-events-auto',
      )}
      aria-hidden={!open}
    >
      <div
        className={classNames(
          'absolute inset-0 bg-black/60 backdrop-blur-md transition-opacity duration-200 motion-reduce:transition-none',
          open ? 'opacity-100' : 'opacity-0',
        )}
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Aurora workspace"
        className={classNames(
          'absolute right-0 top-0 flex h-full w-full flex-col bg-[#0c0d0e] shadow-2xl ring-1 ring-white/[0.04]',
          'transition-transform duration-300 ease-out motion-reduce:transition-none',
          'md:w-[420px] lg:w-[460px]',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <header className="flex items-center justify-between border-b border-white/[0.04] px-5 py-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-dark-text-subtle">
              workspace
            </p>
            <h2 className="mt-0.5 font-display text-[17px] font-semibold text-dark-text-primary">
              Aurora controls
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close workspace"
            className="grid h-9 w-9 place-items-center rounded-full text-dark-text-muted transition hover:bg-white/[0.06] hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40"
          >
            <IconX size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <Section title="State">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-serif text-[14px] text-dark-text-secondary">
                  Aurora is currently <strong className="text-dark-text-primary">{enabled ? 'awake' : 'paused'}</strong>.
                </p>
                {hasActiveRun && (
                  <p className="mt-1 font-mono text-[11px] text-dark-text-muted">
                    {activeRun?.status} · started {relativeTime(activeRun?.startedAt || activeRun?.createdAt)}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant={enabled ? 'secondary' : 'accent'}
                onClick={onTogglePause}
                isLoading={busy === 'config'}
                leftIcon={enabled ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />}
              >
                {enabled ? 'Pause' : 'Resume'}
              </Button>
            </div>
            {hasActiveRun && (
              <Button
                size="xs"
                variant="danger"
                onClick={onCancelActiveRun}
                isLoading={busy === 'cancel'}
                leftIcon={<IconPlayerStop size={12} />}
                className="mt-3"
              >
                Cancel active run
              </Button>
            )}
          </Section>

          <Section title="Compose run">
            <Textarea
              value={manualPrompt}
              onChange={(event) => setManualPrompt(event.target.value)}
              placeholder="Whisper an instruction for the next sweep…"
              maxRows={5}
            />
            <Button
              variant="accent"
              size="sm"
              isLoading={busy === 'run'}
              onClick={() => {
                onEnqueueRun(manualPrompt);
                setManualPrompt('');
              }}
              fullWidth
              className="mt-2"
              leftIcon={<IconPlayerPlay size={14} />}
            >
              Send to Aurora
            </Button>
          </Section>

          <Section title="Schedule">
            <label className="block">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-dark-text-subtle">
                run every
              </span>
              <div className="mt-1.5 flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  size="sm"
                  className="w-24"
                  value={intervalHours}
                  onChange={(event) => setIntervalHours(event.target.value)}
                />
                <span className="font-serif text-[14px] text-dark-text-muted">hours</span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onUpdateInterval(Math.max(1, Number(intervalHours || 4)))}
                  isLoading={busy === 'config'}
                  className="ml-auto"
                >
                  Save
                </Button>
              </div>
            </label>
          </Section>

          <Collapsible title="Goals" badge={goals.length} defaultOpen>
            <div className="space-y-2">
              <Input
                size="sm"
                value={goalTitle}
                onChange={(event) => setGoalTitle(event.target.value)}
                placeholder="New goal"
              />
              <Textarea
                value={goalDescription}
                onChange={(event) => setGoalDescription(event.target.value)}
                placeholder="What should Aurora watch for?"
                maxRows={3}
              />
              <Button
                size="xs"
                variant="secondary"
                isLoading={busy === 'goal'}
                onClick={() => {
                  if (!goalTitle.trim()) return;
                  onCreateGoal(goalTitle, goalDescription);
                  setGoalTitle('');
                  setGoalDescription('');
                }}
                leftIcon={<IconPlus size={12} />}
              >
                Add goal
              </Button>
            </div>
            <div className="mt-4 space-y-3">
              {goals.length === 0 ? (
                <p className="font-serif text-[13px] italic text-dark-text-muted">No goals yet.</p>
              ) : (
                goals.slice(0, 12).map((goal) => (
                  <article key={goal.id} className="border-t border-white/[0.04] pt-2.5 first:border-t-0 first:pt-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="truncate font-display text-[14px] font-semibold text-dark-text-primary">
                        {goal.title}
                      </p>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-dark-text-subtle">
                        {goal.status}
                      </span>
                    </div>
                    {goal.description && (
                      <p className="mt-1 font-serif text-[13px] leading-snug text-dark-text-muted">
                        {goal.description}
                      </p>
                    )}
                  </article>
                ))
              )}
            </div>
          </Collapsible>

          <Collapsible title="History" badge={runs.length}>
            <div className="space-y-3">
              {runs.length === 0 ? (
                <p className="font-serif text-[13px] italic text-dark-text-muted">No runs yet.</p>
              ) : (
                runs.slice(0, 12).map((run) => (
                  <article key={run.id} className="border-t border-white/[0.04] pt-2.5 first:border-t-0 first:pt-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className={classNames('font-mono text-[10px] uppercase tracking-wider', runStatusTone(run.status))}>
                        {run.status}
                      </span>
                      <span className="font-mono text-[10px] text-dark-text-subtle">
                        {relativeTime(run.startedAt || run.createdAt)}
                      </span>
                    </div>
                    {run.summary && (
                      <p className="mt-1 line-clamp-3 font-serif text-[13px] leading-snug text-dark-text-secondary">
                        {run.summary}
                      </p>
                    )}
                  </article>
                ))
              )}
            </div>
          </Collapsible>

          <Collapsible title="Diagnostics" badge={events.length}>
            <ol className="space-y-1.5">
              {events.length === 0 ? (
                <p className="font-serif text-[13px] italic text-dark-text-muted">No events.</p>
              ) : (
                events.slice(0, 30).map((event) => (
                  <li key={event.id} className="flex gap-2 font-mono text-[11px]">
                    <span className="w-16 shrink-0 text-dark-text-subtle">
                      {relativeTime(event.createdAt)}
                    </span>
                    <span
                      className={classNames(
                        'shrink-0 text-[10px] uppercase tracking-wider',
                        event.level === 'error' && 'text-nvidia-red',
                        event.level === 'warn' && 'text-amber-300',
                        event.level === 'info' && 'text-nvidia-green/70',
                      )}
                    >
                      {event.type}
                    </span>
                    <span className="min-w-0 break-words text-dark-text-muted">{event.message}</span>
                  </li>
                ))
              )}
            </ol>
          </Collapsible>
        </div>
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-dark-text-subtle">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Collapsible({
  title,
  badge,
  children,
  defaultOpen = false,
}: {
  title: string;
  badge?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      className="group mb-3 rounded-md border border-white/[0.04] bg-white/[0.015] open:bg-white/[0.025]"
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.22em] text-dark-text-muted transition hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40">
        <span className="flex items-center gap-2">
          {title}
          {typeof badge === 'number' && badge > 0 && (
            <span className="rounded bg-white/[0.06] px-1.5 py-px text-[10px] tracking-wider text-dark-text-secondary">
              {badge}
            </span>
          )}
        </span>
        <IconChevronDown
          size={12}
          className="transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="px-3 pb-4 pt-1">{children}</div>
    </details>
  );
}

function runStatusTone(status: string): string {
  if (status === 'completed') return 'text-emerald-400/80';
  if (status === 'failed' || status === 'cancelled') return 'text-nvidia-red/80';
  if (status === 'waiting_approval') return 'text-amber-300/80';
  if (status === 'running') return 'text-nvidia-green/80';
  return 'text-dark-text-subtle';
}
