// @vitest-environment node
import { outcomeNote } from '@/utils/app/autonomyPresentation';

import type { AutonomyAction } from '@/types/autonomy';

import { dashboardState } from '@/server/autonomy/presentation';
import { emptyState } from '@/server/autonomy/store';
import { expect, it } from 'vitest';

function action(
  id: string,
  time: number,
  status = 'completed',
): AutonomyAction {
  return {
    id,
    kind: 'cluster_maintenance',
    responsibility: 'cluster',
    status,
    dueAt: time,
    createdAt: time,
    updatedAt: time,
    attempts: 1,
    payload: { secret: 'DIAGNOSTIC' },
    outcome: {
      reportVersion: 1,
      status: 'deferred',
      summary:
        'Search is blocked. Update the chart and test a search after deployment.',
      evidence: [{ description: 'DIAGNOSTIC'.repeat(1000) }],
      recommendations: ['DIAGNOSTIC'],
      observedState: { raw: 'DIAGNOSTIC' },
    },
  };
}
it('returns the latest handoff once and excludes every diagnostic/history surface', () => {
  const state = emptyState();
  for (let i = 0; i < 500; i++) state.actions[String(i)] = action(String(i), i);
  state.notes.cluster = 'DIAGNOSTIC';
  state.records.private = 'DIAGNOSTIC';
  state.summaries = [
    {
      id: 'old',
      date: '2026-11-08',
      title: 'Daily summary',
      message: 'DIAGNOSTIC',
      createdAt: 0,
      items: [],
    },
  ];
  const before = structuredClone(state);
  const view = dashboardState(state, 1000);
  expect(Object.keys(view.actions)).toEqual(['499']);
  expect(view).not.toHaveProperty('summaries');
  expect(view).not.toHaveProperty('runs');
  expect(view).not.toHaveProperty('notes');
  expect(JSON.stringify(view)).not.toContain('DIAGNOSTIC');
  expect(JSON.stringify(view).length).toBeLessThan(1000);
  expect(state).toEqual(before);
});
it('keeps running work stoppable and counts queued work without returning a log', () => {
  const state = emptyState();
  for (let i = 0; i < 100; i++)
    state.actions[String(i)] = {
      ...action(String(i), i, 'pending'),
      outcome: null,
    };
  state.actions.running = action('running', 101, 'running');
  const view = dashboardState(state, 1000);
  expect(view.runningCount).toBe(1);
  expect(view.queuedCount).toBe(100);
  expect(Object.keys(view.actions)).toHaveLength(4);
  expect(view.actions.running.status).toBe('running');
});
it('preserves a short next step from legacy recommendations without reproducing skipped actions', () => {
  const note = outcomeNote({
    status: 'deferred',
    summary: 'Search is unavailable. Repeated old diagnostics. More inventory.',
    recommendations: [
      'Raise the querynode limit in your chart. Detailed numbers follow.',
    ],
    skipped: ['Do not restart', 'No network change'],
  });
  expect(note).toBe(
    'Search is unavailable. Raise the querynode limit in your chart.',
  );
});
it('bounds legacy notes and ideas without exposing their long detail fields', () => {
  const state = emptyState();
  const legacy = action('legacy', 1);
  legacy.outcome!.summary = 'A long sentence '.repeat(500);
  state.actions.legacy = legacy;
  state.proposals.p = {
    id: 'p',
    title: 'A title '.repeat(50),
    benefit: 'A benefit '.repeat(100),
    status: 'proposed',
    updatedAt: 1,
    trigger: 'DIAGNOSTIC',
    actions: 'DIAGNOSTIC',
    requiredAccess: 'DIAGNOSTIC',
    limits: 'DIAGNOSTIC',
  };
  const view = dashboardState(state);
  expect(view.actions.legacy.outcome!.summary.length).toBeLessThanOrEqual(600);
  expect(
    view.actions.legacy.outcome!.summary.split(/\s+/).length,
  ).toBeLessThanOrEqual(80);
  expect(view.proposals.p.title.length).toBeLessThanOrEqual(80);
  expect(view.proposals.p.benefit.length).toBeLessThanOrEqual(240);
  expect(JSON.stringify(view)).not.toContain('DIAGNOSTIC');
});

it('keeps one latest result per automation, even when an older action was updated later', () => {
  const state = emptyState();
  for (const [id, ruleId, time] of [
    ['old-cleanup', 'cleanup', 30],
    ['cleanup', 'cleanup', 20],
    ['weather', 'weather', 15],
  ] as const) {
    state.actions[id] = {
      ...action(id, time),
      kind: 'automation',
      responsibility: 'automations',
      payload: { ruleId, title: ruleId, instructions: 'DIAGNOSTIC' },
    };
  }
  state.runs = [
    {
      id: 'first-attempt',
      actionId: 'old-cleanup',
      kind: 'automation',
      responsibility: 'automations',
      status: 'completed',
      startedAt: 5,
      completedAt: 10,
      outcome: state.actions['old-cleanup'].outcome,
    },
  ];
  const view = dashboardState(state);
  expect(Object.keys(view.actions).sort()).toEqual(['cleanup', 'weather']);
  expect(view.actions.cleanup.lastRunAt).toBe(20);
  expect(view.actions.weather.payload.ruleId).toBe('weather');
  expect(JSON.stringify(view)).not.toContain('DIAGNOSTIC');
  expect(view).not.toHaveProperty('runs');
});

it('preserves the result time while an automation retries', () => {
  const state = emptyState();
  state.actions.retry = {
    ...action('retry', 30, 'running'),
    kind: 'automation',
    responsibility: 'automations',
    payload: { ruleId: 'cleanup' },
  };
  state.runs = [
    {
      id: 'retry',
      actionId: 'retry',
      kind: 'automation',
      responsibility: 'automations',
      status: 'running',
      startedAt: 30,
      completedAt: null,
      outcome: null,
    },
    {
      id: 'first',
      actionId: 'retry',
      kind: 'automation',
      responsibility: 'automations',
      status: 'deferred',
      startedAt: 5,
      completedAt: 10,
      outcome: state.actions.retry.outcome,
    },
  ];
  const view = dashboardState(state);
  expect(Object.keys(view.actions)).toEqual(['retry']);
  expect(view.actions.retry.lastRunAt).toBe(10);
  expect(view.actions.retry.status).toBe('running');
  expect(view.actions.retry.outcome?.status).toBe('deferred');
});
