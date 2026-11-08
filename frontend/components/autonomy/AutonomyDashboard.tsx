'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AutonomyConfig,
  AutonomyState,
  Outcome,
  Responsibility,
} from '@/types/autonomy';

const labels: Record<Responsibility, string> = {
  calendar: 'Local calendar',
  lighting: 'MSU game lighting',
  cluster: 'Cluster maintenance',
  evolution: 'Continual improvement',
};
const descriptions: Record<Responsibility, string> = {
  calendar:
    'Keep practical dates and local activities current through your connected Google calendar.',
  lighting:
    'Turn on reachable lights and apply Go Green! at game start. Leave them as-is afterward.',
  cluster:
    'Investigate and repair problems while preserving working connections. Recommend upgrades without installing them.',
  evolution:
    'Learn what helps you and propose additional responsibilities in the daily summary.',
};
const buttonClass =
  'min-h-touch-min max-w-full whitespace-normal break-words rounded-lg border border-separator px-3 py-2 text-sm hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50';
const inputClass =
  'mt-1 w-full rounded-lg border border-separator bg-control px-3 py-2 text-sm';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok)
    throw new Error(
      'The request could not be completed. Refresh and try again.',
    );
  return response.json();
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
function Evidence({ outcome }: { outcome: Outcome }) {
  return (
    <div className="space-y-2 text-sm">
      <p>{outcome.summary}</p>
      {!!outcome.skipped?.length && (
        <p>Skipped: {outcome.skipped.join(', ')}</p>
      )}
      {outcome.recommendations?.map((text, index) => (
        <p key={index}>{text}</p>
      ))}
      {!!outcome.evidence?.length && (
        <details>
          <summary className="cursor-pointer">Verification evidence</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {outcome.evidence.map((item, index) => (
              <li key={index}>
                {item.description}
                {item.reference && /^https?:\/\//i.test(item.reference) ? (
                  <>
                    {' '}
                    <a
                      className="underline"
                      href={item.reference}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Source
                    </a>
                  </>
                ) : item.reference ? (
                  <span> ({item.reference})</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function AutonomyDashboard() {
  const [config, setConfig] = useState<AutonomyConfig | null>(null);
  const [state, setState] = useState<AutonomyState | null>(null);
  const [draft, setDraft] = useState<AutonomyConfig | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const [settings, activity] = await Promise.all([
        request<AutonomyConfig>('/api/autonomy/config'),
        request<AutonomyState>('/api/autonomy/state'),
      ]);
      if (current !== generation.current) return;
      setConfig(settings);
      setState(activity);
    } catch {
      if (current === generation.current)
        setError('Updates are unavailable. Showing any last saved activity.');
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 15000);
    return () => {
      window.clearInterval(timer);
      generation.current += 1;
    };
  }, [refresh]);
  async function perform(
    path: string,
    body: unknown,
    message: string,
    method = 'POST',
  ) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setNotice(message);
      setDraft(null);
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const save = (patch: unknown) =>
    perform('/api/autonomy/config', patch, 'Charter settings saved.', 'PUT');
  const operate = (body: unknown, message: string) =>
    perform('/api/autonomy/state', body, message);
  const edit = (fn: (next: AutonomyConfig) => void) => {
    if (!draft) return;
    const next = structuredClone(draft);
    fn(next);
    setDraft(next);
  };
  return (
    <div className="app-page app-workspace h-full overflow-y-auto pb-8 text-dark-text-primary">
      <div className="app-content-rail space-y-6 break-words pt-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Autonomy</h1>
            <p className="text-sm text-dark-text-secondary">
              Your charter, daily summaries, and completed work.
            </p>
          </div>
          <div className="flex max-w-full flex-wrap gap-2">
            <button
              className={buttonClass}
              onClick={() => {
                setError('');
                void refresh();
              }}
            >
              Refresh
            </button>
            {config && (
              <button
                disabled={busy}
                className={buttonClass}
                onClick={() => void save({ enabled: !config.enabled })}
              >
                {config.enabled ? 'Pause all' : 'Resume all'}
              </button>
            )}
          </div>
        </header>
        {error && (
          <p role="alert" className="rounded-lg bg-control p-3">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {!config && !error && <p role="status">Loading charter…</p>}
        {config && (
          <>
            <section
              aria-label="Initial charter"
              className="grid gap-3 md:grid-cols-2"
            >
              {(Object.keys(labels) as Responsibility[]).map((name) => (
                <article
                  key={name}
                  className="min-w-0 rounded-xl border border-separator p-4"
                >
                  <h2 className="font-semibold">{labels[name]}</h2>
                  <p className="my-2 text-sm text-dark-text-secondary">
                    {descriptions[name]}
                  </p>
                  <p className="mb-2 text-sm">
                    {config.enabled && config.responsibilities[name].enabled
                      ? 'Active'
                      : 'Paused'}{' '}
                    · every {config.responsibilities[name].intervalSeconds / 60}{' '}
                    minutes
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      disabled={busy}
                      className={buttonClass}
                      onClick={() =>
                        void save({
                          responsibilities: {
                            [name]: {
                              enabled: !config.responsibilities[name].enabled,
                            },
                          },
                        })
                      }
                    >
                      {config.responsibilities[name].enabled
                        ? 'Pause'
                        : 'Resume'}{' '}
                      {labels[name]}
                    </button>
                    <button
                      disabled={
                        busy ||
                        !config.enabled ||
                        !config.responsibilities[name].enabled
                      }
                      className={buttonClass}
                      onClick={() =>
                        void operate(
                          { operation: 'run', responsibility: name },
                          'Responsibility queued.',
                        )
                      }
                    >
                      Check now
                    </button>
                  </div>
                </article>
              ))}
            </section>
            <section className="rounded-xl border border-separator p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p>
                  Daily summary at {config.summary.time} Eastern · new
                  responsibilities are proposed for your review.
                </p>
                <button
                  className={buttonClass}
                  onClick={() =>
                    setDraft(draft ? null : structuredClone(config))
                  }
                >
                  {draft ? 'Close settings' : 'Settings'}
                </button>
              </div>
              {draft && (
                <form
                  className="mt-4 space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(draft);
                  }}
                >
                  <label className="block text-sm">
                    Summary time (Eastern)
                    <input
                      type="time"
                      required
                      className={inputClass}
                      value={draft.summary.time}
                      onChange={(event) =>
                        edit((next) => {
                          next.summary.time = event.target.value;
                        })
                      }
                    />
                  </label>
                  <div className="grid gap-3 md:grid-cols-2">
                    {(Object.keys(labels) as Responsibility[]).map((name) => (
                      <label key={name} className="block text-sm">
                        {labels[name]} check interval (minutes)
                        <input
                          type="number"
                          min={5}
                          max={10080}
                          required
                          className={inputClass}
                          value={
                            draft.responsibilities[name].intervalSeconds / 60
                          }
                          onChange={(event) =>
                            edit((next) => {
                              next.responsibilities[name].intervalSeconds =
                                Number(event.target.value) * 60;
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <label className="block text-sm">
                    Google calendar ID (leave blank to use your saved preference
                    or sole writable calendar)
                    <input
                      className={inputClass}
                      value={draft.responsibilities.calendar.calendarId}
                      onChange={(event) =>
                        edit((next) => {
                          next.responsibilities.calendar.calendarId =
                            event.target.value;
                        })
                      }
                    />
                  </label>
                  <label className="block text-sm">
                    Local sources (one URL per line)
                    <textarea
                      className={inputClass}
                      value={draft.responsibilities.calendar.sources.join('\n')}
                      onChange={(event) =>
                        edit((next) => {
                          next.responsibilities.calendar.sources =
                            event.target.value.split('\n');
                        })
                      }
                    />
                  </label>
                  <label className="block text-sm">
                    Local interests, area, and household applicability
                    <textarea
                      className={inputClass}
                      value={draft.responsibilities.calendar.preferences}
                      onChange={(event) =>
                        edit((next) => {
                          next.responsibilities.calendar.preferences =
                            event.target.value;
                        })
                      }
                    />
                  </label>
                  <label className="block text-sm">
                    Reminder lead times (minutes, comma separated; blank
                    preserves calendar defaults)
                    <input
                      className={inputClass}
                      value={draft.responsibilities.calendar.reminderMinutes.join(
                        ',',
                      )}
                      onChange={(event) =>
                        edit((next) => {
                          next.responsibilities.calendar.reminderMinutes =
                            event.target.value.trim()
                              ? event.target.value.split(',').map(Number)
                              : [];
                        })
                      }
                    />
                  </label>
                  <label className="block text-sm">
                    Lighting scene
                    <input
                      required
                      className={inputClass}
                      value={draft.responsibilities.lighting.scene}
                      onChange={(event) =>
                        edit((next) => {
                          next.responsibilities.lighting.scene =
                            event.target.value;
                        })
                      }
                    />
                  </label>
                  <label className="block text-sm">
                    Missed game start allowance (minutes)
                    <input
                      type="number"
                      min={0}
                      max={60}
                      className={inputClass}
                      value={draft.responsibilities.lighting.catchUpMinutes}
                      onChange={(event) =>
                        edit((next) => {
                          next.responsibilities.lighting.catchUpMinutes =
                            Number(event.target.value);
                        })
                      }
                    />
                  </label>
                  <p className="text-sm">
                    Repairs use cluster-managed configuration. Backups remain in
                    the affected namespace; externally managed changes are
                    reported for review.
                  </p>
                  <label className="block text-sm">
                    Non-node LAN verification source
                    <input
                      className={inputClass}
                      value={
                        draft.responsibilities.cluster.lanVerificationSource
                      }
                      onChange={(event) =>
                        edit((next) => {
                          next.responsibilities.cluster.lanVerificationSource =
                            event.target.value;
                        })
                      }
                    />
                  </label>
                  <label className="block text-sm">
                    Cluster maintenance boundaries
                    <textarea
                      className={inputClass}
                      value={draft.responsibilities.cluster.maintenancePolicy}
                      onChange={(event) =>
                        edit((next) => {
                          next.responsibilities.cluster.maintenancePolicy =
                            event.target.value;
                        })
                      }
                    />
                  </label>
                  <button disabled={busy} className={buttonClass} type="submit">
                    Save settings
                  </button>
                </form>
              )}
            </section>
          </>
        )}
        <section aria-label="Daily summaries" className="space-y-3">
          <h2 className="text-xl font-semibold">Daily summaries</h2>
          {state && !state.summaries.length && (
            <p className="text-sm text-dark-text-secondary">
              Your first summary will appear at the scheduled time. Work in
              progress is listed below.
            </p>
          )}
          {state?.summaries.map((summary) => (
            <article
              key={summary.id}
              className="space-y-3 rounded-xl border border-separator p-4"
            >
              <h3 className="font-semibold">{summary.title}</h3>
              {summary.message && <p>{summary.message}</p>}
              {summary.items.map((item, index) => (
                <div key={index} className="border-t border-separator pt-3">
                  <p className="mb-1 text-sm font-medium">
                    {item.responsibility} · {item.status}
                  </p>
                  {item.summary && (
                    <Evidence
                      outcome={{
                        ...item,
                        status: item.status as Outcome['status'],
                        summary: item.summary,
                      }}
                    />
                  )}
                  {item.proposal && (
                    <div>
                      <p className="font-medium">{item.proposal.title}</p>
                      <p>{item.proposal.benefit}</p>
                      <details>
                        <summary className="cursor-pointer text-sm">
                          Proposed responsibility
                        </summary>
                        <p>Trigger: {item.proposal.trigger}</p>
                        <p>Actions: {item.proposal.actions}</p>
                        <p>Access: {item.proposal.requiredAccess}</p>
                        <p>Limits: {item.proposal.limits}</p>
                      </details>
                      {state.proposals[item.proposal.id]?.status ===
                        'proposed' && (
                        <div className="flex flex-wrap gap-2">
                          <button
                            className={buttonClass}
                            disabled={busy}
                            onClick={() =>
                              void operate(
                                { operation: 'accept', id: item.proposal!.id },
                                'Interest saved. This idea does not yet have permission to act.',
                              )
                            }
                          >
                            Mark useful
                          </button>
                          <button
                            className={buttonClass}
                            disabled={busy}
                            onClick={() =>
                              void operate(
                                { operation: 'dismiss', id: item.proposal!.id },
                                'Proposal dismissed. This preference will be retained.',
                              )
                            }
                          >
                            Dismiss proposal
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </article>
          ))}
        </section>
        <section aria-label="Action history" className="space-y-3">
          <h2 className="text-xl font-semibold">
            Scheduled work and action history
          </h2>
          {state && !Object.keys(state.actions).length && (
            <p>The worker has not scheduled any work yet.</p>
          )}
          {state &&
            Object.values(state.actions)
              .sort(
                (a, b) =>
                  Number(['pending', 'running'].includes(b.status)) -
                    Number(['pending', 'running'].includes(a.status)) ||
                  b.updatedAt - a.updatedAt,
              )
              .slice(0, 50)
              .map((item) => (
                <details
                  key={item.id}
                  className="rounded-lg border border-separator p-3"
                >
                  <summary className="cursor-pointer">
                    {labels[item.responsibility as Responsibility] ||
                      'Daily summary'}{' '}
                    {typeof item.payload.title === 'string' &&
                      `· ${item.payload.title} `}
                    {typeof item.payload.opponent === 'string' &&
                      `· MSU vs ${item.payload.opponent} `}
                    · {item.status} · {timestamp(item.dueAt)}
                  </summary>
                  <div className="mt-3 space-y-2">
                    {item.outcome && <Evidence outcome={item.outcome} />}
                    {['pending', 'running'].includes(item.status) && (
                      <button
                        className={buttonClass}
                        disabled={busy}
                        onClick={() =>
                          void operate(
                            { operation: 'cancel', id: item.id },
                            'Stop requested. Any uncertain effects will be recorded.',
                          )
                        }
                      >
                        {item.status === 'running'
                          ? 'Stop action'
                          : 'Cancel scheduled action'}
                      </button>
                    )}
                  </div>
                </details>
              ))}
        </section>
      </div>
    </div>
  );
}
