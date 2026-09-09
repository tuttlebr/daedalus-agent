'use client';

import {
  IconChevronDown,
  IconChecklist,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconTrash,
  IconUpload,
  IconX,
} from '@tabler/icons-react';
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  AutonomyConfig,
  AutonomyEvent,
  AutonomyGoal,
  AutonomyQueuedRequest,
  AutonomyRun,
} from '@/types/autonomy';

import { Button, IconButton, Input, Textarea } from '@/components/primitives';
import { ModalSurface } from '@/components/surfaces';

import { isActiveRun, relativeTime } from './utils';

import classNames from 'classnames';

interface WorkspaceDrawerProps {
  open: boolean;
  onClose: () => void;
  config: AutonomyConfig | null;
  goals: AutonomyGoal[];
  runs: AutonomyRun[];
  queue: AutonomyQueuedRequest[];
  events: AutonomyEvent[];
  activeRun: AutonomyRun | undefined;
  busy: string | null;
  error: string | null;
  notice: string | null;
  onTogglePause: () => void;
  onEnqueueRun: (prompt: string) => Promise<boolean>;
  onRunActiveGoals: (prompt: string) => Promise<boolean>;
  onCancelActiveRun: () => void;
  onCancelQueuedRequest: (id: string) => void;
  onUpdateInterval: (hours: number) => void;
  onCreateGoal: (title: string, description: string) => Promise<boolean>;
  onImportGoals: (payload: unknown) => void | Promise<void>;
  onImportProfile: (payload: unknown) => void | Promise<void>;
  onDeleteGoal: (id: string) => void;
}

export function WorkspaceDrawer({
  open,
  onClose,
  config,
  goals,
  runs,
  queue,
  events,
  activeRun,
  busy,
  error,
  notice,
  onTogglePause,
  onEnqueueRun,
  onRunActiveGoals,
  onCancelActiveRun,
  onCancelQueuedRequest,
  onUpdateInterval,
  onCreateGoal,
  onImportGoals,
  onImportProfile,
  onDeleteGoal,
}: WorkspaceDrawerProps) {
  const feedbackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && (error || notice))
      feedbackRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error, notice, open]);
  const goalImportInputRef = useRef<HTMLInputElement>(null);
  const profileImportInputRef = useRef<HTMLInputElement>(null);
  const [manualPrompt, setManualPrompt] = useState('');
  const [intervalHours, setIntervalHours] = useState('4');
  const [goalTitle, setGoalTitle] = useState('');
  const [goalDescription, setGoalDescription] = useState('');
  const [goalImportError, setGoalImportError] = useState('');
  const [profileImportError, setProfileImportError] = useState('');

  const configuredInterval = config?.intervalSeconds;
  useEffect(() => {
    if (configuredInterval === undefined) return;
    setIntervalHours(
      String(Math.max(1, Math.round((configuredInterval || 14400) / 3600))),
    );
  }, [configuredInterval]);

  const enabled = !!config?.enabled;
  const hasActiveRun = isActiveRun(activeRun);
  const activeGoalCount = goals.filter(
    (goal) => goal.status === 'active',
  ).length;
  const goalTitleById = useMemo(
    () => new Map(goals.map((goal) => [goal.id, goal.title])),
    [goals],
  );
  const resolveGoalTitle = useCallback(
    (goalId?: string | null) =>
      goalId ? goalTitleById.get(goalId) || goalId : '',
    [goalTitleById],
  );

  const handleGoalFileSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (
          goals.length &&
          parsed?.mode !== 'append' &&
          !window.confirm(
            'Replace all existing goals with the goals in this file?',
          )
        )
          return;
        await onImportGoals(parsed);
        setGoalImportError('');
      } catch (error) {
        setGoalImportError(
          error instanceof SyntaxError
            ? 'Could not read this file. Choose a valid goals JSON file.'
            : 'Could not import goals. Your existing goals are still shown. Try again.',
        );
      } finally {
        event.target.value = '';
      }
    },
    [onImportGoals, goals.length],
  );

  const handleProfileFileSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        await onImportProfile(parsed);
        setProfileImportError('');
      } catch (error: any) {
        setProfileImportError(
          error?.message || 'Import failed. Use a profile JSON object.',
        );
      } finally {
        event.target.value = '';
      }
    },
    [onImportProfile],
  );

  return (
    <ModalSurface
      open={open}
      onClose={onClose}
      position="right"
      aria-label="Daedalus workspace"
      className="flex h-full w-full max-w-md flex-col bg-panel shadow-xl"
    >
      <header className="safe-top flex flex-wrap items-center justify-between gap-2 border-b border-separator/70 px-4 py-3">
        <h2 className="min-w-0 break-words text-sm font-semibold text-primary sm:text-base">
          Workspace
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close workspace"
          className="grid h-[44px] w-[44px] shrink-0 place-items-center rounded-full text-dark-text-muted transition hover:bg-fill/[0.06] hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40"
        >
          <IconX size={18} />
        </button>
      </header>

      <div className="safe-bottom min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div ref={feedbackRef}>
          {error && (
            <p
              role="alert"
              className="mb-4 rounded-lg border border-nvidia-red/30 bg-nvidia-red/10 p-3 text-sm text-nvidia-red"
            >
              {error}
            </p>
          )}
          {notice && (
            <p
              role="status"
              className="mb-4 rounded-lg bg-control p-3 text-sm text-primary"
            >
              {notice}
            </p>
          )}
        </div>
        <fieldset disabled={busy !== null} className="min-w-0">
          <Section title="State">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1 basis-40">
                <p className="font-sans text-[0.875rem] text-dark-text-secondary">
                  Daedalus is currently{' '}
                  <strong className="text-dark-text-primary">
                    {enabled ? 'awake' : 'paused'}
                  </strong>
                  .
                </p>
                {hasActiveRun && (
                  <p className="mt-1 font-mono text-[0.75rem] text-dark-text-muted">
                    {activeRun?.status} · started{' '}
                    {relativeTime(activeRun?.startedAt || activeRun?.createdAt)}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant={enabled ? 'secondary' : 'accent'}
                onClick={onTogglePause}
                isLoading={busy === 'config'}
                leftIcon={
                  enabled ? (
                    <IconPlayerPause size={14} />
                  ) : (
                    <IconPlayerPlay size={14} />
                  )
                }
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

          <Section title="Profile">
            <input
              ref={profileImportInputRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={handleProfileFileSelected}
            />
            <Button
              size="xs"
              variant="secondary"
              isLoading={busy === 'profile:import'}
              disabled={busy !== null && busy !== 'profile:import'}
              onClick={() => profileImportInputRef.current?.click()}
              leftIcon={<IconUpload size={12} />}
            >
              Import profile JSON
            </Button>
            {profileImportError && (
              <p
                role="alert"
                className="mt-2 font-sans text-[0.75rem] text-nvidia-red"
              >
                {profileImportError}
              </p>
            )}
          </Section>

          <Section title="Compose run">
            <label
              htmlFor="autonomy-run-instruction"
              className="mb-2 block text-sm text-secondary"
            >
              Instructions (optional)
            </label>
            <Textarea
              id="autonomy-run-instruction"
              value={manualPrompt}
              onChange={(event) => setManualPrompt(event.target.value)}
              placeholder="What should Daedalus work on?"
              maxRows={5}
            />
            <Button
              variant="accent"
              size="sm"
              isLoading={busy === 'run'}
              onClick={async () => {
                if (await onEnqueueRun(manualPrompt)) setManualPrompt('');
              }}
              fullWidth
              className="mt-2"
              leftIcon={<IconPlayerPlay size={14} />}
            >
              Send to Daedalus
            </Button>
            <Button
              variant="secondary"
              size="sm"
              isLoading={busy === 'run:goals'}
              disabled={activeGoalCount === 0}
              onClick={async () => {
                if (await onRunActiveGoals(manualPrompt)) setManualPrompt('');
              }}
              fullWidth
              className="mt-2"
              leftIcon={<IconChecklist size={14} />}
            >
              Run active goals
            </Button>
          </Section>

          <Section title="Schedule">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const hours = Number(intervalHours);
                if (Number.isFinite(hours) && hours >= 1)
                  onUpdateInterval(hours);
              }}
            >
              <label
                htmlFor="autonomy-interval"
                className="block text-sm text-secondary"
              >
                Run every (hours)
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Input
                  id="autonomy-interval"
                  type="number"
                  min={1}
                  step={1}
                  required
                  size="sm"
                  wrapperClassName="min-w-0 flex-1 basis-24"
                  value={intervalHours}
                  onChange={(event) => setIntervalHours(event.target.value)}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  isLoading={busy === 'config'}
                >
                  Save schedule
                </Button>
              </div>
            </form>
          </Section>

          <Collapsible title="Goals" badge={goals.length} defaultOpen>
            <div className="space-y-2">
              <label
                htmlFor="autonomy-goal-title"
                className="block text-sm text-secondary"
              >
                Goal name
              </label>
              <Input
                id="autonomy-goal-title"
                size="sm"
                value={goalTitle}
                onChange={(event) => setGoalTitle(event.target.value)}
                placeholder="New goal"
              />
              <label
                htmlFor="autonomy-goal-description"
                className="block text-sm text-secondary"
              >
                Goal details (optional)
              </label>
              <Textarea
                id="autonomy-goal-description"
                value={goalDescription}
                onChange={(event) => setGoalDescription(event.target.value)}
                placeholder="What should Daedalus watch for?"
                maxRows={3}
              />
              <Button
                size="xs"
                variant="secondary"
                isLoading={busy === 'goal'}
                disabled={!goalTitle.trim()}
                onClick={async () => {
                  if (await onCreateGoal(goalTitle, goalDescription)) {
                    setGoalTitle('');
                    setGoalDescription('');
                  }
                }}
                leftIcon={<IconPlus size={12} />}
              >
                Add goal
              </Button>
              <input
                ref={goalImportInputRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={handleGoalFileSelected}
              />
              <Button
                size="xs"
                variant="ghost"
                isLoading={busy === 'goal:import'}
                disabled={busy !== null && busy !== 'goal:import'}
                onClick={() => goalImportInputRef.current?.click()}
                leftIcon={<IconUpload size={12} />}
              >
                Import JSON
              </Button>
              {goalImportError && (
                <p
                  role="alert"
                  className="font-sans text-[0.75rem] text-nvidia-red"
                >
                  {goalImportError}
                </p>
              )}
            </div>
            <div className="mt-4 space-y-3">
              {goals.length === 0 ? (
                <p className="font-sans text-[0.8125rem] italic text-dark-text-muted">
                  No goals yet.
                </p>
              ) : (
                goals.map((goal) => (
                  <article
                    key={goal.id}
                    className="border-t border-separator/70 pt-2.5 first:border-t-0 first:pt-0"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 basis-48">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <p className="break-words font-display text-[0.875rem] font-semibold text-dark-text-primary">
                            {goal.title}
                          </p>
                          <span className="shrink-0 font-mono text-[0.75rem] uppercase tracking-wider text-dark-text-subtle">
                            {goal.status}
                          </span>
                        </div>
                        {goal.description && (
                          <p className="mt-1 font-sans text-[0.8125rem] leading-snug text-dark-text-muted">
                            {goal.description}
                          </p>
                        )}
                      </div>
                      <IconButton
                        size="xs"
                        variant="danger"
                        icon={<IconTrash />}
                        aria-label={`Delete goal: ${goal.title}`}
                        tooltip="Delete goal"
                        isLoading={busy === `goal:${goal.id}`}
                        disabled={busy !== null && busy !== `goal:${goal.id}`}
                        onClick={() => {
                          if (
                            window.confirm(`Delete the goal “${goal.title}”?`)
                          )
                            onDeleteGoal(goal.id);
                        }}
                        className="shrink-0"
                      />
                    </div>
                  </article>
                ))
              )}
            </div>
          </Collapsible>

          <Collapsible
            title="Queue"
            badge={queue.length}
            defaultOpen={queue.length > 0}
          >
            <div className="space-y-3">
              {queue.length === 0 ? (
                <p className="font-sans text-[0.8125rem] italic text-dark-text-muted">
                  No queued requests.
                </p>
              ) : (
                queue.map((request) => (
                  <article
                    key={request.id}
                    className="border-t border-separator/70 pt-2.5 first:border-t-0 first:pt-0"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="shrink-0 font-mono text-[0.75rem] uppercase tracking-wider text-nvidia-green">
                          {request.position === 1
                            ? 'next'
                            : `#${request.position}`}
                        </span>
                        <span className="truncate font-mono text-[0.75rem] uppercase tracking-wider text-dark-text-subtle">
                          {request.trigger}
                        </span>
                      </div>
                      <span className="shrink-0 font-mono text-[0.75rem] text-dark-text-subtle">
                        {relativeTime(request.createdAt)}
                      </span>
                    </div>
                    <p className="mt-1 font-sans text-[0.8125rem] leading-snug text-dark-text-secondary">
                      {request.prompt?.trim() || 'No prompt supplied.'}
                    </p>
                    {request.goalId && (
                      <p className="mt-1 break-words font-sans text-[0.75rem] text-dark-text-muted">
                        Goal: {resolveGoalTitle(request.goalId)}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
                      <p className="min-w-0 break-words text-[0.75rem] text-dark-text-subtle">
                        Requested by {request.requestedBy}
                      </p>
                      <button
                        type="button"
                        onClick={() => onCancelQueuedRequest(request.id)}
                        disabled={busy === request.id}
                        className="shrink-0 font-mono text-[0.75rem] uppercase tracking-wider text-dark-text-subtle transition-colors hover:text-nvidia-red disabled:opacity-40"
                      >
                        {busy === request.id ? 'cancelling' : 'cancel'}
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </Collapsible>

          <Collapsible title="History" badge={runs.length}>
            <div className="space-y-3">
              {runs.length === 0 ? (
                <p className="font-sans text-[0.8125rem] italic text-dark-text-muted">
                  No runs yet.
                </p>
              ) : (
                runs.map((run) => (
                  <article
                    key={run.id}
                    className="border-t border-separator/70 pt-2.5 first:border-t-0 first:pt-0"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <span
                        className={classNames(
                          'font-mono text-[0.75rem] uppercase tracking-wider',
                          runStatusTone(run.status),
                        )}
                      >
                        {run.status}
                      </span>
                      <span className="font-mono text-[0.75rem] text-dark-text-subtle">
                        {relativeTime(run.startedAt || run.createdAt)}
                      </span>
                    </div>
                    {run.summary && (
                      <p className="mt-1 font-sans text-[0.8125rem] leading-snug text-dark-text-secondary">
                        {run.summary}
                      </p>
                    )}
                    {run.goalId && (
                      <p className="mt-1 break-words font-sans text-[0.75rem] text-dark-text-muted">
                        Goal: {resolveGoalTitle(run.goalId)}
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
                <p className="font-sans text-[0.8125rem] italic text-dark-text-muted">
                  No events.
                </p>
              ) : (
                events.map((event) => (
                  <li
                    key={event.id}
                    className="flex flex-wrap gap-2 font-mono text-[0.75rem]"
                  >
                    <span className="w-16 shrink-0 text-dark-text-subtle">
                      {relativeTime(event.createdAt)}
                    </span>
                    <span
                      className={classNames(
                        'max-w-full break-words text-[0.75rem] uppercase tracking-wider [overflow-wrap:anywhere]',
                        event.level === 'error' && 'text-nvidia-red',
                        event.level === 'warn' && 'text-nvidia-orange',
                        event.level === 'info' && 'text-nvidia-green',
                      )}
                    >
                      {event.type}
                    </span>
                    <span className="min-w-0 break-words text-dark-text-muted">
                      {event.message}
                    </span>
                  </li>
                ))
              )}
            </ol>
          </Collapsible>
        </fieldset>
      </div>
    </ModalSurface>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 font-mono text-[0.75rem] uppercase tracking-[0.22em] text-dark-text-subtle">
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
      className="group mb-3 rounded-md border border-separator/70 bg-fill/[0.015] open:bg-fill/[0.025]"
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium text-dark-text-secondary transition hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40">
        <span className="flex min-w-0 flex-wrap items-center gap-2 [overflow-wrap:anywhere]">
          {title}
          {typeof badge === 'number' && badge > 0 && (
            <span className="rounded bg-fill/[0.06] px-1.5 py-px text-[0.75rem] tracking-wider text-dark-text-secondary">
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
  if (status === 'completed') return 'text-nvidia-teal';
  if (status === 'failed' || status === 'cancelled' || status === 'aborted')
    return 'text-nvidia-red';
  if (status === 'skipped') return 'text-nvidia-orange';
  if (status === 'running') return 'text-nvidia-green';
  return 'text-dark-text-subtle';
}
