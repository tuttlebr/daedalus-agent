import { outcomeNote, shortText } from '@/utils/app/autonomyPresentation';

import type {
  AutonomyAction,
  AutonomyState,
  AutonomyView,
} from '@/types/autonomy';

const areas = [
  'calendar',
  'lighting',
  'cluster',
  'evolution',
  'automations',
] as const;

/** The dashboard receives current work and short public notes, never stored
 * runs, notes, briefings, raw evidence, observed state or repeated history. */
export function dashboardState(
  state: AutonomyState,
  now = Date.now(),
): AutonomyView {
  const actions: Record<string, AutonomyAction> = {};
  const visible = Object.values(state.actions).filter((item) =>
    areas.includes(item.responsibility as (typeof areas)[number]),
  );
  const running = visible.filter((item) => item.status === 'running');
  const queued = visible.filter(
    (item) => item.status === 'pending' && item.dueAt <= now,
  );
  const add = (item: AutonomyAction) => {
    actions[item.id] = {
      id: item.id,
      kind: item.kind,
      responsibility: item.responsibility,
      status: item.status,
      dueAt: item.dueAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      attempts: item.attempts,
      cancelledByUser: item.cancelledByUser,
      payload:
        item.kind === 'automation'
          ? {
              ruleId: item.payload.ruleId,
              title: shortText(
                String(item.payload.title || 'Automation'),
                10,
                80,
              ),
            }
          : {},
      outcome: item.outcome
        ? {
            status: item.outcome.status,
            summary: outcomeNote(item.outcome),
            reportVersion: 1,
          }
        : null,
    };
  };
  const ruleIds = [
    ...new Set(
      visible
        .filter((item) => item.kind === 'automation' && item.outcome)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((item) => item.payload.ruleId),
    ),
  ].slice(0, 50);
  for (const id of ruleIds) {
    const latest = visible
      .filter(
        (item) =>
          item.kind === 'automation' &&
          item.payload.ruleId === id &&
          item.outcome,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) add(latest);
  }
  for (const area of areas) {
    const latest = visible
      .filter((item) => item.responsibility === area && item.outcome)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) add(latest);
    // Keep every running action stoppable, plus a bounded sample of queued work.
    running.filter((item) => item.responsibility === area).forEach(add);
    queued
      .filter((item) => item.responsibility === area)
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, 3)
      .forEach(add);
  }
  const proposals: AutonomyView['proposals'] = {};
  const seen = new Set<string>();
  for (const idea of Object.values(state.proposals)
    .filter((idea) => idea.status === 'proposed')
    .sort((a, b) => b.updatedAt - a.updatedAt)) {
    const title = shortText(idea.title, 10, 80);
    const benefit = shortText(idea.benefit, 35, 240);
    const key = `${title} ${benefit}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    proposals[idea.id] = {
      id: idea.id,
      title,
      benefit,
      status: idea.status,
      updatedAt: idea.updatedAt,
    };
    if (Object.keys(proposals).length >= 30) break;
  }
  return {
    version: 2,
    actions,
    proposals,
    runningCount: running.length,
    queuedCount: queued.length,
  };
}
