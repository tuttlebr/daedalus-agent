import type {
  AutomationPlan,
  AutonomyConfig,
  LightingRule,
  Responsibility,
} from '@/types/autonomy';

import { applyConfigPatch, defaultConfig } from './config';

import { createHash, randomUUID } from 'node:crypto';

const names: Responsibility[] = [
  'calendar',
  'lighting',
  'cluster',
  'evolution',
];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid automation plan');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Unsupported automation setting');
}
export function configRevision(config: AutonomyConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}
function validateRule(
  config: AutonomyConfig,
  candidate: unknown,
): LightingRule {
  const rule = object(candidate);
  // Rule arrays replace in ordinary JSON patches, so validate the complete new
  // member before appending it atomically to the live list.
  const { rules: _rules, ...defaults } =
    defaultConfig().responsibilities.lighting;
  const next = applyConfigPatch(config, {
    responsibilities: { lighting: { rules: [{ ...defaults, ...rule }] } },
  });
  return next.responsibilities.lighting.rules[0];
}
export function parseAutomationPlan(
  value: unknown,
  config: AutonomyConfig,
  instructions: string,
): AutomationPlan {
  const plan = object(value);
  if (plan.type === 'clarify' || plan.type === 'unsupported') {
    keys(plan, ['type', 'message']);
    if (
      typeof plan.message !== 'string' ||
      !plan.message.trim() ||
      plan.message.length > 500
    )
      throw new Error('Invalid planning response');
    return { type: plan.type, message: plan.message };
  }
  if (plan.type === 'lighting_rule') {
    keys(plan, ['type', 'settings']);
    const settings = object(plan.settings);
    keys(settings, [
      'title',
      'team',
      'sports',
      'scene',
      'weekdays',
      'months',
      'intervalSeconds',
      'catchUpMinutes',
      'lightIds',
    ]);
    // These determine what runs and when. Never silently fill omitted criteria
    // from the legacy MSU rule or default calendar.
    for (const key of [
      'title',
      'team',
      'sports',
      'scene',
      'weekdays',
      'months',
    ]) {
      if (!Object.hasOwn(settings, key))
        throw new Error('Incomplete lighting plan');
    }
    const rule = validateRule(config, {
      intervalSeconds: 3600,
      ...settings,
      id: randomUUID(),
      enabled: true,
      instructions,
    });
    return { type: 'lighting_rule', rule };
  }
  if (plan.type === 'settings') {
    keys(plan, ['type', 'responsibility', 'settings']);
    if (!names.includes(plan.responsibility as Responsibility))
      throw new Error('Unsupported responsibility');
    const responsibility = plan.responsibility as Responsibility;
    const settings = object(plan.settings);
    if (!Object.keys(settings).length || Object.hasOwn(settings, 'rules'))
      throw new Error('Specify changed settings');
    applyConfigPatch(config, {
      responsibilities: { [responsibility]: settings },
    });
    return {
      type: 'settings',
      responsibility,
      settings,
      baseRevision: configRevision(config),
    };
  }
  throw new Error('Unsupported automation plan');
}
export function applyAutomationPlan(
  config: AutonomyConfig,
  candidate: unknown,
): AutonomyConfig {
  const plan = object(candidate);
  if (plan.type === 'rule_state' || plan.type === 'remove_rule') {
    keys(
      plan,
      plan.type === 'rule_state' ? ['type', 'id', 'enabled'] : ['type', 'id'],
    );
    if (
      typeof plan.id !== 'string' ||
      (plan.type === 'rule_state' && typeof plan.enabled !== 'boolean')
    )
      throw new Error('Invalid rule change');
    const rules = config.responsibilities.lighting.rules;
    if (!rules.some((rule) => rule.id === plan.id))
      throw new Error('Automation no longer exists');
    return applyConfigPatch(config, {
      responsibilities: {
        lighting: {
          rules:
            plan.type === 'remove_rule'
              ? rules.filter((rule) => rule.id !== plan.id)
              : rules.map((rule) =>
                  rule.id === plan.id
                    ? { ...rule, enabled: plan.enabled }
                    : rule,
                ),
        },
      },
    });
  }
  if (plan.type === 'lighting_rule') {
    keys(plan, ['type', 'rule']);
    const rule = validateRule(config, plan.rule);
    const existing = config.responsibilities.lighting.rules.find(
      (item) => item.id === rule.id,
    );
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(rule))
        throw new Error('A different rule already uses this ID');
      return config;
    }
    return applyConfigPatch(config, {
      responsibilities: {
        lighting: { rules: [...config.responsibilities.lighting.rules, rule] },
      },
    });
  }
  if (plan.type === 'settings') {
    keys(plan, ['type', 'responsibility', 'settings', 'baseRevision']);
    if (plan.baseRevision !== configRevision(config))
      throw new Error('Settings changed. Preview the instructions again.');
    const checked = parseAutomationPlan(
      {
        type: plan.type,
        responsibility: plan.responsibility,
        settings: plan.settings,
      },
      config,
      '',
    );
    if (checked.type !== 'settings') throw new Error('Invalid settings plan');
    return applyConfigPatch(config, {
      responsibilities: { [checked.responsibility]: checked.settings },
    });
  }
  throw new Error('Preview an automation before saving');
}
