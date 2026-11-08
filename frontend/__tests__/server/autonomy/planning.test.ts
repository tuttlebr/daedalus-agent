// @vitest-environment node
import { defaultConfig } from '@/server/autonomy/config';
import {
  applyAutomationPlan,
  parseAutomationPlan,
} from '@/server/autonomy/planning';
import { describe, expect, it } from 'vitest';

const draft = {
  type: 'lighting_rule',
  settings: {
    title: 'Steelers kickoff',
    team: 'Pittsburgh Steelers',
    sports: ['football'],
    scene: 'Go Steelers!',
    weekdays: [6, 0, 3],
    months: [9, 10, 11, 12, 1, 2],
    intervalSeconds: 3600,
  },
};
describe('automation planning', () => {
  it('previews without changing config, appends once, and preserves existing lighting', () => {
    const config = defaultConfig();
    const before = structuredClone(config);
    const plan = parseAutomationPlan(draft, config, 'My instructions');
    expect(config).toEqual(before);
    const next = applyAutomationPlan(config, plan);
    expect(config).toEqual(before);
    expect(next.responsibilities.lighting.scene).toBe('Go Green!');
    expect(next.responsibilities.lighting.rules).toHaveLength(1);
    expect(next.responsibilities.lighting.rules[0]).toMatchObject({
      ...draft.settings,
      instructions: 'My instructions',
    });
    expect(applyAutomationPlan(next, plan)).toEqual(next);
    expect(() =>
      applyAutomationPlan(next, { type: 'clarify', message: 'When?' }),
    ).toThrow();
  });
  it.each([
    { ...draft, settings: { ...draft.settings, command: 'anything' } },
    { ...draft, settings: { ...draft.settings, months: [0] } },
    { ...draft, settings: { ...draft.settings, weekdays: [6, 6] } },
    { ...draft, settings: { ...draft.settings, sports: ['baseball'] } },
    { ...draft, settings: { title: 'Missing details' } },
    {
      type: 'settings',
      responsibility: 'cluster',
      settings: { permissions: 'all' },
    },
    { type: 'settings', responsibility: 'lighting', settings: { rules: [] } },
    { type: 'unsupported', message: 'x'.repeat(501) },
  ])('rejects invalid or unsupported output %j', (value) => {
    expect(() => parseAutomationPlan(value, defaultConfig(), '')).toThrow();
  });
  it('rejects a stale settings preview while appending rules to the latest config', () => {
    const config = defaultConfig();
    const edit = parseAutomationPlan(
      {
        type: 'settings',
        responsibility: 'cluster',
        settings: { intervalSeconds: 1800 },
      },
      config,
      'Check twice an hour',
    );
    const first = parseAutomationPlan(draft, config, 'First');
    const second = parseAutomationPlan(draft, config, 'Second');
    const next = applyAutomationPlan(config, first);
    expect(() => applyAutomationPlan(next, edit)).toThrow('Settings changed');
    const both = applyAutomationPlan(next, second);
    expect(both.responsibilities.lighting.rules).toHaveLength(2);
    const id = both.responsibilities.lighting.rules[0].id;
    const paused = applyAutomationPlan(both, {
      type: 'rule_state',
      id,
      enabled: false,
    });
    expect(
      paused.responsibilities.lighting.rules.map((rule) => rule.enabled),
    ).toEqual([false, true]);
    const removed = applyAutomationPlan(paused, { type: 'remove_rule', id });
    expect(removed.responsibilities.lighting.rules).toHaveLength(1);
    expect(removed.responsibilities.lighting.rules[0].instructions).toBe(
      'Second',
    );
  });
});
