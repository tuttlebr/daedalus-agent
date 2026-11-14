'use client';

import { useEffect, useRef, useState } from 'react';

import {
  AutonomyRequestError,
  autonomyResponseError,
} from '@/utils/app/autonomyRequest';

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
  'Every weekday at 8:00 AM, check the weather forecast for Saline and summarize whether I should expect rain.';

export function AutomationComposer({
  busy,
  paused,
  lightingPaused,
  automationsPaused = false,
  onApply,
}: {
  busy: boolean;
  paused: boolean;
  lightingPaused: boolean;
  automationsPaused?: boolean;
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
    if (plan?.type !== 'clarify') setPlan(null);
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
        throw await autonomyResponseError(
          response,
          'The automation preview failed. Your instructions are still here; try again.',
        );
      let result: AutomationPlan;
      try {
        result = await response.json();
        if (
          !result ||
          ![
            'automation',
            'lighting_rule',
            'settings',
            'clarify',
            'unsupported',
          ].includes(result.type)
        )
          throw new Error('Invalid preview');
      } catch {
        throw new AutonomyRequestError(
          'Daedalus returned an unreadable automation preview. Your instructions are still here; try again.',
        );
      }
      setPlan(result);
      setInstructions(text);
      setAnswer('');
    } catch (error) {
      setError(
        controller.signal.aborted
          ? 'The automation preview timed out. Your instructions are still here; try previewing again.'
          : error instanceof AutonomyRequestError
          ? error.message
          : 'Could not reach Daedalus. Check your connection, then preview again. Your instructions are still here.',
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
              Try a weather example
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
          Automation blocked: {plan.message}
        </p>
      )}
      {plan &&
        (plan.type === 'automation' ||
          plan.type === 'lighting_rule' ||
          plan.type === 'settings') && (
          <div className="space-y-3 rounded-xl border border-separator p-4">
            <h3 className="font-medium">
              {plan.type !== 'settings'
                ? plan.rule.title
                : `Update ${plan.responsibility}`}
            </h3>
            {plan.type === 'automation' ? (
              <div className="space-y-2 text-sm">
                <p>{plan.rule.instructions}</p>
                <p>
                  {describeWindow(plan.rule.weekdays, plan.rule.months)}{' '}
                  (Eastern)
                </p>
                <p>
                  {plan.rule.dailyTimes.length
                    ? `At ${plan.rule.dailyTimes.join(', ')}. Runs within ${
                        plan.rule.catchUpMinutes
                      } minutes of the scheduled time.`
                    : `Check every ${plan.rule.intervalSeconds / 60} minutes.`}
                </p>
              </div>
            ) : plan.type === 'lighting_rule' ? (
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
                  {describeWindow(plan.rule.weekdays, plan.rule.months)}{' '}
                  (Eastern)
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
            {!paused && automationsPaused && plan.type === 'automation' && (
              <p className="text-sm text-dark-text-secondary">
                Custom automations are paused. Resume them to run this
                automation.
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
          Describe a task using your connected services, when it should run, and
          any conditions to check. Daedalus checks its available tools before
          preparing a preview. You can choose regular intervals or daily times,
          weekdays and months.
        </p>
      </details>
    </section>
  );
}
