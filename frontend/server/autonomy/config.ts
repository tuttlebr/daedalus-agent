import type { AutonomyConfig } from '@/types/autonomy';

import contract from './contract.json';

// Generated from the Python contract. Support only the schema vocabulary it
// emits; unknown keywords must be added deliberately rather than ignored.
type Schema = {
  $ref?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  required?: string[];
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};
const definitions = contract.schema.$defs as Record<string, Schema>;

function validate(value: unknown, schema: Schema, path: string): void {
  if (schema.$ref) {
    const definition = definitions[schema.$ref.replace('#/$defs/', '')];
    if (!definition) throw new Error('Unknown configuration schema');
    return validate(value, definition, path);
  }
  const fail = () => {
    throw new Error(`Invalid autonomy setting: ${path}`);
  };
  if (schema.const !== undefined && value !== schema.const) fail();
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return fail();
    const record = value as Record<string, unknown>;
    for (const name of schema.required || []) if (!(name in record)) fail();
    for (const [name, entry] of Object.entries(record)) {
      const child = schema.properties?.[name];
      if (!child) fail();
      else validate(entry, child, `${path}.${name}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return fail();
    if (
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      fail();
    for (const item of value) validate(item, schema.items!, path);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return fail();
    if (
      value.trim().length < (schema.minLength ?? 0) ||
      value.length > (schema.maxLength ?? Infinity) ||
      (schema.pattern && !new RegExp(schema.pattern).test(value))
    )
      fail();
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (schema.type === 'integer' && !Number.isInteger(value)) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity)
    )
      fail();
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') fail();
}

export function defaultConfig(): AutonomyConfig {
  return structuredClone(contract.defaults) as AutonomyConfig;
}

function merge(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current };
  for (const [name, value] of Object.entries(patch)) {
    if (['__proto__', 'prototype', 'constructor'].includes(name))
      throw new Error('Invalid setting');
    const old = current[name];
    next[name] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      old &&
      typeof old === 'object' &&
      !Array.isArray(old)
        ? merge(
            old as Record<string, unknown>,
            value as Record<string, unknown>,
          )
        : value;
  }
  return next;
}

export function applyConfigPatch(
  current: AutonomyConfig,
  patch: unknown,
): AutonomyConfig {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new Error('Expected an autonomy settings object');
  // Existing files can contain retired briefing settings. Ignore them on read
  // and import; they no longer appear in the supported schema or downloads.
  const {
    summary: _summary,
    maxSummariesStored: _maxSummariesStored,
    ...activePatch
  } = patch as Record<string, unknown>;
  const merged = merge(
    structuredClone(current) as unknown as Record<string, unknown>,
    activePatch,
  );
  const lighting = (merged.responsibilities as Record<string, unknown>)
    ?.lighting as Record<string, unknown> | undefined;
  if (lighting && Array.isArray(lighting.rules)) {
    const { rules: _rules, ...defaults } =
      defaultConfig().responsibilities.lighting;
    lighting.rules = lighting.rules.map((rule) =>
      rule && typeof rule === 'object' && !Array.isArray(rule)
        ? merge(defaults as unknown as Record<string, unknown>, rule)
        : rule,
    );
  }
  validate(merged, contract.schema as Schema, 'config');
  const config = merged as unknown as AutonomyConfig;
  if (
    config.maxPendingActions <=
    config.responsibilities.lighting.rules.length + 4
  )
    throw new Error('Leave queue capacity for discovery and game actions');
  for (const settings of [
    ...Object.values(config.responsibilities),
    ...config.responsibilities.lighting.rules,
  ]) {
    for (const values of [settings.weekdays, settings.months]) {
      if (new Set(values).size !== values.length)
        throw new Error('Window values must be unique');
    }
  }
  if (
    new Set(config.responsibilities.lighting.rules.map((rule) => rule.id))
      .size !== config.responsibilities.lighting.rules.length
  )
    throw new Error('Lighting rule IDs must be unique');
  for (const source of config.responsibilities.calendar.sources) {
    const url = new URL(source);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      source.length > 2048
    )
      throw new Error('Invalid calendar source URL');
  }
  if (
    config.responsibilities.calendar.reminderMinutes.some(
      (n) => n < 0 || n > 40320,
    )
  )
    throw new Error('Invalid reminder lead time');
  return config;
}
