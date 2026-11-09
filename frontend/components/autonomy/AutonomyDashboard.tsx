'use client';

import {
  IconActivity,
  IconArrowRight,
  IconLoader2,
  IconRefresh,
} from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { outcomeNote, shortText } from '@/utils/app/autonomyPresentation';

import type {
  AutonomyConfig,
  AutonomyView,
  Responsibility,
} from '@/types/autonomy';

import { AutomationComposer, describeWindow } from './AutomationComposer';
import { AutonomyJson, buttonClass } from './AutonomyJson';

const labels: Record<Responsibility, string> = {
  calendar: 'Calendar',
  lighting: 'Home',
  cluster: 'System health',
  evolution: 'Learning',
};
const names = Object.keys(labels) as Responsibility[];
const statusLabels: Record<string, string> = {
  completed: 'Verified',
  partial: 'Partly completed',
  failed: 'Needs attention',
  deferred: 'Blocked',
  uncertain: 'Needs verification',
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, {
      ...options,
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error('The request could not be completed. Try again.');
    return await response.json();
  } finally {
    window.clearTimeout(timer);
  }
}
function timestamp(value: number) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Detroit',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(value);
}
function Spinner() {
  return (
    <IconLoader2
      size={16}
      aria-hidden="true"
      className="shrink-0 motion-safe:animate-spin"
    />
  );
}
export function AutonomyDashboard() {
  const [config, setConfig] = useState<AutonomyConfig | null>(null);
  const [state, setState] = useState<AutonomyView | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [ideaPage, setIdeaPage] = useState(0);
  const [selectedArea, setSelectedArea] = useState<Responsibility>('cluster');
  const generation = useRef(0);
  const working = useRef(false);

  const refresh = useCallback(async (manual = false) => {
    if (manual) {
      setRefreshing(true);
      setNotice('');
    }
    const current = ++generation.current;
    try {
      const [settings, activity] = await Promise.all([
        request<AutonomyConfig>('/api/autonomy/config'),
        request<AutonomyView>('/api/autonomy/state'),
      ]);
      if (current !== generation.current) return;
      setConfig(settings);
      setState(activity);
      setUpdatedAt(Date.now());
      setError('');
      if (manual) setNotice('Up to date.');
    } catch {
      if (current === generation.current)
        setError('Updates are unavailable. Showing any last saved activity.');
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !working.current)
        void refresh();
    }, 15000);
    return () => {
      window.clearInterval(timer);
      generation.current += 1;
    };
  }, [refresh]);

  async function perform(
    key: string,
    path: string,
    body: unknown,
    message: string,
    method = 'POST',
  ) {
    if (working.current) return false;
    working.current = true;
    // Invalidate reads started before this mutation; they cannot restore old settings.
    generation.current += 1;
    setPending(key);
    setError('');
    setNotice('');
    try {
      const result = await request<AutonomyConfig>(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (method === 'PUT') setConfig(result);
      setNotice(message);
      await refresh();
      return true;
    } catch {
      setError(
        'The request could not be completed. Your changes have not been confirmed. Try again.',
      );
      return false;
    } finally {
      working.current = false;
      setPending('');
    }
  }
  const save = (key: string, patch: unknown, message: string) =>
    perform(key, '/api/autonomy/config', patch, message, 'PUT');
  const operate = (key: string, body: unknown, message: string) =>
    perform(key, '/api/autonomy/state', body, message);
  const busy = !!pending;
  const actions = Object.values(state?.actions || {}).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  const running = actions.filter((item) => item.status === 'running');
  const queued = actions.filter(
    (item) => item.status === 'pending' && item.dueAt <= Date.now(),
  );
  const proposals = Object.values(state?.proposals || {})
    .filter((item) => item.status === 'proposed')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const page = Math.min(
    ideaPage,
    Math.max(0, Math.ceil(proposals.length / 3) - 1),
  );
  const enabledCount = config
    ? names.filter((name) => config.responsibilities[name].enabled).length
    : 0;

  return (
    <div className="app-page app-workspace h-full overflow-y-auto pb-8 text-dark-text-primary">
      <div className="app-content-rail space-y-5 break-words pt-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Autonomy</h1>
          </div>
          <div className="flex max-w-full flex-wrap gap-2">
            <button
              className={buttonClass}
              disabled={refreshing || busy}
              aria-busy={refreshing}
              onClick={() => void refresh(true)}
            >
              {refreshing ? (
                <Spinner />
              ) : (
                <IconRefresh size={16} aria-hidden="true" />
              )}
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            {config && (
              <button
                className={buttonClass}
                disabled={busy}
                aria-busy={pending === 'toggle'}
                onClick={() =>
                  void save(
                    'toggle',
                    { enabled: !config.enabled },
                    config.enabled
                      ? 'Autonomy paused. Active work is being stopped.'
                      : 'Autonomy resumed. Scheduled work can run.',
                  )
                }
              >
                {pending === 'toggle' && <Spinner />}
                {pending === 'toggle'
                  ? 'Updating…'
                  : config.enabled
                  ? 'Pause all'
                  : 'Resume all'}
              </button>
            )}
          </div>
        </header>
        {error && (
          <p
            role="alert"
            className="rounded-xl border border-separator bg-control p-3 text-sm"
          >
            {error}
          </p>
        )}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={notice ? 'text-sm' : 'sr-only'}
        >
          {notice}
        </div>
        {!config && !error && (
          <p role="status" className="flex items-center gap-2">
            <Spinner />
            Loading autonomy…
          </p>
        )}
        {config && (
          <>
            <div
              aria-label="Autonomy status"
              className="flex flex-wrap items-center gap-2 text-sm text-dark-text-secondary"
            >
              <IconActivity size={18} aria-hidden="true" />
              <span>
                {!state
                  ? 'Activity unavailable'
                  : !config.enabled || !enabledCount
                  ? 'Autonomy paused'
                  : running.length
                  ? 'Checking…'
                  : 'Active'}
              </span>
              {!!(state?.queuedCount ?? queued.length) && (
                <span>· {state?.queuedCount ?? queued.length} queued</span>
              )}
              {updatedAt && (
                <span className="ml-auto text-xs">
                  Updated {timestamp(updatedAt)}
                </span>
              )}
            </div>
            <details className="rounded-2xl border border-separator bg-panel p-4">
              <summary className="min-h-touch-min cursor-pointer py-2 font-medium">
                Add automation
              </summary>
              <AutomationComposer
                lightingPaused={!config.responsibilities.lighting.enabled}
                busy={busy}
                paused={!config.enabled}
                onApply={(plan) =>
                  perform(
                    'plan',
                    '/api/autonomy/plan',
                    plan,
                    'Automation saved.',
                    'PUT',
                  )
                }
              />
            </details>
            <div className="space-y-4">
              <section
                aria-labelledby="areas-heading"
                className="min-w-0 rounded-2xl border border-separator bg-panel"
              >
                <div className="p-4">
                  <h2 id="areas-heading" className="font-semibold">
                    Automations
                  </h2>
                </div>
                <div
                  role="group"
                  aria-label="Areas"
                  className="flex flex-wrap gap-2 border-t border-separator px-4 pt-4"
                >
                  {names.map((name) => (
                    <button
                      key={name}
                      className={`${buttonClass} ${
                        selectedArea === name
                          ? 'bg-control font-semibold ring-1 ring-focus'
                          : ''
                      }`}
                      aria-pressed={selectedArea === name}
                      onClick={() => setSelectedArea(name)}
                    >
                      {labels[name]}
                      {running.some((item) => item.responsibility === name) && (
                        <>
                          <Spinner />
                          <span className="sr-only">working</span>
                        </>
                      )}
                    </button>
                  ))}
                </div>
                {names
                  .filter((name) => name === selectedArea)
                  .map((name) => {
                    const active = actions.filter(
                      (item) =>
                        item.responsibility === name &&
                        (item.status === 'running' ||
                          (item.status === 'pending' &&
                            item.dueAt <= Date.now())),
                    );
                    const latest = actions.find(
                      (item) => item.responsibility === name && item.outcome,
                    );
                    const enabled =
                      config.enabled && config.responsibilities[name].enabled;
                    const runKey = `run:${name}`;
                    const toggleKey = `toggle:${name}`;
                    return (
                      <article
                        key={name}
                        aria-label={labels[name]}
                        className="space-y-3 p-4"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="flex items-center gap-2 text-xs text-dark-text-secondary">
                            {active.some(
                              (item) => item.status === 'running',
                            ) ? (
                              <>
                                <Spinner />
                                Working
                              </>
                            ) : active.length ? (
                              'Queued'
                            ) : latest?.outcome ? (
                              statusLabels[latest.outcome.status]
                            ) : !enabled ? (
                              'Paused'
                            ) : (
                              'Awaiting first check'
                            )}
                          </span>
                        </div>
                        {name === 'lighting' &&
                          config.responsibilities.lighting.rules.map((rule) => (
                            <div
                              key={rule.id}
                              className="space-y-2 rounded-xl border border-separator p-3 text-sm"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <h4 className="font-medium">{rule.title}</h4>
                                <span>
                                  {rule.enabled ? 'Enabled' : 'Paused'}
                                </span>
                              </div>
                              <p>
                                {rule.team} · {rule.scene}
                              </p>
                              <p className="text-dark-text-secondary">
                                {describeWindow(rule.weekdays, rule.months)}
                              </p>
                              <div className="flex flex-wrap gap-2">
                                <button
                                  className={buttonClass}
                                  disabled={busy}
                                  onClick={() =>
                                    void perform(
                                      `rule:${rule.id}`,
                                      '/api/autonomy/plan',
                                      {
                                        type: 'rule_state',
                                        id: rule.id,
                                        enabled: !rule.enabled,
                                      },
                                      `${rule.title} ${
                                        rule.enabled ? 'paused' : 'enabled'
                                      }.`,
                                      'PUT',
                                    )
                                  }
                                >
                                  {pending === `rule:${rule.id}`
                                    ? 'Updating…'
                                    : rule.enabled
                                    ? 'Pause'
                                    : 'Resume'}
                                </button>
                                <button
                                  className={buttonClass}
                                  disabled={busy}
                                  onClick={() =>
                                    void perform(
                                      `remove:${rule.id}`,
                                      '/api/autonomy/plan',
                                      { type: 'remove_rule', id: rule.id },
                                      'Automation removed.',
                                      'PUT',
                                    )
                                  }
                                >
                                  {pending === `remove:${rule.id}`
                                    ? 'Removing…'
                                    : 'Remove'}
                                </button>
                              </div>
                            </div>
                          ))}
                        {latest?.outcome && (
                          <div>
                            <p className="text-xs text-dark-text-secondary">
                              {timestamp(latest.updatedAt)}
                            </p>
                            <p
                              className="text-sm leading-relaxed"
                              data-testid="autonomy-note"
                            >
                              {outcomeNote(latest.outcome)}
                            </p>
                          </div>
                        )}
                        {active.map((item) => (
                          <div
                            key={item.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-control px-3 py-2 text-sm"
                          >
                            <span>
                              {item.cancelledByUser
                                ? 'Stopping…'
                                : item.status === 'running'
                                ? 'Check in progress'
                                : 'Check queued'}
                            </span>
                            <button
                              className={buttonClass}
                              disabled={busy || item.cancelledByUser}
                              aria-busy={pending === `cancel:${item.id}`}
                              onClick={() =>
                                void operate(
                                  `cancel:${item.id}`,
                                  { operation: 'cancel', id: item.id },
                                  'Stop requested. Any uncertain effects will be recorded.',
                                )
                              }
                            >
                              {pending === `cancel:${item.id}` && <Spinner />}
                              {pending === `cancel:${item.id}`
                                ? 'Stopping…'
                                : item.status === 'running'
                                ? 'Stop action'
                                : 'Cancel check'}
                            </button>
                          </div>
                        ))}
                        <div className="flex flex-wrap gap-2">
                          <button
                            className={buttonClass}
                            disabled={busy || !enabled || !!active.length}
                            aria-label={`${
                              name === 'evolution' ? 'Review' : 'Check'
                            } ${labels[name]} now`}
                            aria-busy={pending === runKey}
                            onClick={() =>
                              void operate(
                                runKey,
                                { operation: 'run', responsibility: name },
                                `${labels[name]} check queued. Status updates automatically.`,
                              )
                            }
                          >
                            {pending === runKey && <Spinner />}
                            {pending === runKey
                              ? 'Queueing…'
                              : active.some((item) => item.status === 'running')
                              ? 'Working…'
                              : active.length
                              ? 'Queued'
                              : name === 'evolution'
                              ? 'Review now'
                              : 'Check now'}
                          </button>
                          <button
                            className={buttonClass}
                            disabled={busy}
                            aria-label={`${
                              config.responsibilities[name].enabled
                                ? 'Pause'
                                : 'Resume'
                            } ${labels[name]}`}
                            aria-busy={pending === toggleKey}
                            onClick={() =>
                              void save(
                                toggleKey,
                                {
                                  responsibilities: {
                                    [name]: {
                                      enabled:
                                        !config.responsibilities[name].enabled,
                                    },
                                  },
                                },
                                `${labels[name]} ${
                                  config.responsibilities[name].enabled
                                    ? 'paused.'
                                    : config.enabled
                                    ? 'resumed.'
                                    : 'enabled. Resume all to start scheduled work.'
                                }`,
                              )
                            }
                          >
                            {pending === toggleKey && <Spinner />}
                            {pending === toggleKey
                              ? 'Updating…'
                              : config.responsibilities[name].enabled
                              ? 'Pause'
                              : 'Resume'}
                          </button>
                        </div>
                      </article>
                    );
                  })}
              </section>
              <details
                aria-labelledby="learning-heading"
                className="min-w-0 space-y-4 rounded-2xl border border-separator bg-panel p-4"
              >
                <summary className="min-h-touch-min cursor-pointer rounded-lg py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                  <h2 id="learning-heading" className="inline font-semibold">
                    Ideas
                  </h2>
                </summary>
                {!proposals.length && (
                  <p className="rounded-xl bg-control p-4 text-sm text-dark-text-secondary">
                    No new ideas.
                  </p>
                )}
                {proposals.slice(page * 3, page * 3 + 3).map((proposal) => (
                  <article
                    key={proposal.id}
                    className="space-y-3 rounded-xl border border-separator p-4"
                  >
                    <h3 className="font-medium">
                      {shortText(proposal.title, 10, 80)}
                    </h3>
                    <p className="text-sm leading-relaxed">
                      {shortText(proposal.benefit, 35, 240)}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {(['accept', 'dismiss'] as const).map((operation) => {
                        const key = `${operation}:${proposal.id}`;
                        return (
                          <button
                            key={operation}
                            className={buttonClass}
                            disabled={busy}
                            aria-busy={pending === key}
                            onClick={() =>
                              void operate(
                                key,
                                { operation, id: proposal.id },
                                operation === 'accept'
                                  ? 'Saved as useful. No automation enabled.'
                                  : 'Idea dismissed.',
                              )
                            }
                          >
                            {pending === key && <Spinner />}
                            {pending === key
                              ? 'Saving…'
                              : operation === 'accept'
                              ? 'Mark useful'
                              : 'Dismiss idea'}
                          </button>
                        );
                      })}
                    </div>
                  </article>
                ))}
                {proposals.length > 3 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      className={buttonClass}
                      disabled={page === 0}
                      onClick={() => setIdeaPage(page - 1)}
                    >
                      Previous ideas
                    </button>
                    <span className="text-xs">
                      {page + 1} / {Math.ceil(proposals.length / 3)}
                    </span>
                    <button
                      className={buttonClass}
                      disabled={(page + 1) * 3 >= proposals.length}
                      onClick={() => setIdeaPage(page + 1)}
                    >
                      More ideas
                      <IconArrowRight size={16} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </details>
            </div>
            <AutonomyJson
              config={config}
              busy={busy}
              saving={pending === 'import'}
              onApply={(patch) =>
                save('import', patch, 'Automation configuration saved.')
              }
            />
          </>
        )}
      </div>
    </div>
  );
}
