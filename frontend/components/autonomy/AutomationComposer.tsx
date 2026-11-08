'use client';

import { useEffect, useRef, useState } from 'react';

import type { AutomationPlan } from '@/types/autonomy';

import { buttonClass } from './AutonomyJson';

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
export function describeWindow(days: number[], selectedMonths: number[]) {
  return `${
    days.length === 7
      ? 'Every day'
      : days.map((day) => weekdays[day]).join(', ')
  } · ${
    selectedMonths.length === 12
      ? 'All year'
      : selectedMonths.map((month) => months[month - 1]).join(', ')
  }`;
}
function displaySetting(key: string, value: unknown): string {
  if (key === 'weekdays' && Array.isArray(value))
    return value.map((day) => weekdays[day]).join(', ');
  if (key === 'months' && Array.isArray(value))
    return value.map((month) => months[month - 1]).join(', ');
  if (key === 'intervalSeconds') return `Every ${Number(value) / 60} minutes`;
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (Array.isArray(value)) return value.join(', ') || 'None';
  return String(value);
}
const example =
  'At Steelers kickoff, set the house lights to the "Go Steelers!" scene. Only check on Sundays, Mondays and Thursdays from September through February.';

export function AutomationComposer({
  busy,
  paused,
  lightingPaused,
  onApply,
}: {
  busy: boolean;
  paused: boolean;
  lightingPaused: boolean;
  onApply: (plan: AutomationPlan) => Promise<boolean>;
}) {
  const [instructions, setInstructions] = useState('');
  const [plan, setPlan] = useState<AutomationPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);
  async function preview() {
    if (planning || saving) return;
    const text =
      plan?.type === 'clarify' && answer.trim()
        ? `${instructions}\n${plan.message}\n${answer}`
        : instructions;
    if (!text.trim() || text.length > 4000) {
      setError('Use 4,000 characters or fewer.');
      return;
    }
    setPlanning(true);
    setError('');
    setNotice('');
    const controller = new AbortController();
    activeRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 125000);
    try {
      const response = await fetch('/api/autonomy/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: text }),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error('Could not prepare the automation. Try again.');
      setPlan(await response.json());
      setInstructions(text);
      setAnswer('');
    } catch {
      setError(
        'Could not prepare the automation. Your instructions are still here; try again.',
      );
    } finally {
      window.clearTimeout(timeout);
      activeRequest.current = null;
      setPlanning(false);
    }
  }
  const disabled = busy || planning || saving;
  return (
    <section
      aria-labelledby="composer-heading"
      className="space-y-3 rounded-2xl border border-separator bg-panel p-4"
    >
      <h2 id="composer-heading" className="font-semibold">
        Describe an automation
      </h2>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void preview();
        }}
      >
        <label htmlFor="automation-instructions" className="sr-only">
          What should Daedalus do?
        </label>
        <textarea
          id="automation-instructions"
          rows={3}
          maxLength={4000}
          value={instructions}
          disabled={disabled}
          placeholder={example}
          className="w-full rounded-xl border border-separator bg-control p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onChange={(event) => {
            setInstructions(event.target.value);
            setPlan(null);
            setError('');
            setNotice('');
          }}
        />
        {plan?.type === 'clarify' && (
          <div className="space-y-2">
            <label className="block text-sm" htmlFor="automation-answer">
              {plan.message}
            </label>
            <input
              id="automation-answer"
              aria-label="Your answer"
              value={answer}
              disabled={disabled}
              onChange={(event) => setAnswer(event.target.value)}
              className="w-full rounded-xl border border-separator bg-control p-3 text-sm"
            />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            className={buttonClass}
            type="submit"
            disabled={
              disabled ||
              !instructions.trim() ||
              (plan?.type === 'clarify' && !answer.trim())
            }
            aria-busy={planning}
          >
            {planning ? 'Reading instructions…' : 'Preview automation'}
          </button>
          {!instructions && (
            <button
              type="button"
              className={buttonClass}
              disabled={disabled}
              onClick={() => setInstructions(example)}
            >
              Try the Steelers example
            </button>
          )}
        </div>
      </form>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {plan?.type === 'unsupported' && (
        <p role="status" className="text-sm">
          {plan.message}
        </p>
      )}
      {plan && (plan.type === 'lighting_rule' || plan.type === 'settings') && (
        <div className="space-y-3 rounded-xl border border-separator p-4">
          <h3 className="font-medium">
            {plan.type === 'lighting_rule'
              ? plan.rule.title
              : `Update ${plan.responsibility}`}
          </h3>
          {plan.type === 'lighting_rule' ? (
            <div className="space-y-1 text-sm">
              <p>
                At {plan.rule.team} game start: {plan.rule.scene}
              </p>
              <p>
                {plan.rule.sports
                  .map((sport) =>
                    sport === 'football' ? 'Football' : 'Men’s basketball',
                  )
                  .join(', ')}
              </p>
              <p>
                {describeWindow(plan.rule.weekdays, plan.rule.months)} (Eastern)
              </p>
              <p>
                Check every {plan.rule.intervalSeconds / 60} minutes.{' '}
                {plan.rule.lightIds.length
                  ? `${plan.rule.lightIds.length} selected lights.`
                  : 'All household lights.'}
              </p>
              <p className="text-dark-text-secondary">
                Scene availability is checked when this runs.
              </p>
            </div>
          ) : (
            <dl className="space-y-2 text-sm">
              {Object.entries(plan.settings).map(([key, value]) => (
                <div key={key}>
                  <dt className="font-medium">
                    {key.replace(/([A-Z])/g, ' $1')}
                  </dt>
                  <dd>{displaySetting(key, value)}</dd>
                </div>
              ))}
            </dl>
          )}
          {paused && (
            <p className="text-sm text-dark-text-secondary">
              Autonomy is paused. Save now and resume when ready.
            </p>
          )}
          {!paused && lightingPaused && plan.type === 'lighting_rule' && (
            <p className="text-sm text-dark-text-secondary">
              Home automations are paused. Resume Home to run this rule.
            </p>
          )}
          <button
            className={buttonClass}
            disabled={disabled}
            aria-busy={saving}
            onClick={async () => {
              if (saving) return;
              setError('');
              setSaving(true);
              try {
                if (await onApply(plan)) {
                  setPlan(null);
                  setInstructions('');
                  setNotice('Automation saved.');
                } else {
                  setError(
                    'Could not save. Your draft is still here; try again.',
                  );
                }
              } catch {
                setError(
                  'Could not save. Your draft is still here; try again.',
                );
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Saving automation…' : 'Save automation'}
          </button>
        </div>
      )}
      <details className="text-sm">
        <summary className="min-h-touch-min cursor-pointer py-2">
          What can I automate?
        </summary>
        <p>
          Game-start lighting for football and men’s basketball, calendar
          discovery, cluster checks, and improvement reviews. You can choose
          weekdays and months. Requests outside these capabilities return a
          limitation before saving.
        </p>
      </details>
    </section>
  );
}
