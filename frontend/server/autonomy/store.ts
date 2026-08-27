import { publishSyncEvent } from '@/utils/sync/publish';

import {
  AutonomyConfig,
  AutonomyEvent,
  AutonomyFeedItem,
  AutonomyGoal,
  AutonomyQueuedRequest,
  AutonomyRun,
} from '@/types/autonomy';

import { sanitizeSourcePolicy } from '@/server/chat/sourcePolicy';
import { positiveIntegerFromEnv } from '@/server/config/env';
import { getRedis, jsonGet, jsonSet, sessionKey } from '@/server/session/redis';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_INTERVAL_SECONDS = 14_400;
const MIN_INTERVAL_SECONDS = 300; // 5 min floor — block degenerate tight worker loops
const MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const DEFAULT_DEDUPE_WINDOW_DAYS = 14;
const MIN_DEDUPE_WINDOW_DAYS = 1;
const MAX_DEDUPE_WINDOW_DAYS = 90;
const VALID_MODES = new Set(['hybrid', 'research_feed', 'task_executor']);
const VALID_RUNTIMES = new Set(['dedicated_worker']);
const VALID_ACTION_POLICIES = new Set([
  'broad_autonomy',
  'read_memory_only',
  'low_risk_writes',
]);
const VALID_GOAL_STATUSES = new Set(['active', 'paused', 'completed']);
const MAX_IMPORTED_GOALS = 100;
function clampInt(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/**
 * Whitelist + validate a client-supplied config patch before it is persisted
 * and consumed by the autonomous worker. Unknown keys and invalid values are
 * dropped, and numeric fields are clamped, so a client cannot drive the worker
 * into a tight loop (intervalSeconds=0) or set an unrecognized policy (F-009).
 */
export function sanitizeConfigPatch(
  patch: Partial<AutonomyConfig>,
): Partial<AutonomyConfig> {
  const clean: Partial<AutonomyConfig> = {};
  if (!patch || typeof patch !== 'object') return clean;

  if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
  if (typeof patch.mode === 'string' && VALID_MODES.has(patch.mode)) {
    clean.mode = patch.mode;
  }
  if (typeof patch.runtime === 'string' && VALID_RUNTIMES.has(patch.runtime)) {
    clean.runtime = patch.runtime;
  }
  if (
    typeof patch.actionPolicy === 'string' &&
    VALID_ACTION_POLICIES.has(patch.actionPolicy)
  ) {
    clean.actionPolicy = patch.actionPolicy;
  }

  const interval = clampInt(
    patch.intervalSeconds,
    MIN_INTERVAL_SECONDS,
    MAX_INTERVAL_SECONDS,
  );
  if (interval !== undefined) clean.intervalSeconds = interval;

  const maxRuns = clampInt(patch.maxRunsStored, 1, 1000);
  if (maxRuns !== undefined) clean.maxRunsStored = maxRuns;

  const maxFeed = clampInt(patch.maxFeedItems, 1, 2000);
  if (maxFeed !== undefined) clean.maxFeedItems = maxFeed;

  if (typeof patch.feedDedupeEnabled === 'boolean') {
    clean.feedDedupeEnabled = patch.feedDedupeEnabled;
  }
  const dedupeWindow = clampInt(
    patch.feedDedupeWindowDays,
    MIN_DEDUPE_WINDOW_DAYS,
    MAX_DEDUPE_WINDOW_DAYS,
  );
  if (dedupeWindow !== undefined) clean.feedDedupeWindowDays = dedupeWindow;

  const sourcePolicy = sanitizeSourcePolicy(patch.sourcePolicy);
  if (sourcePolicy) {
    clean.sourcePolicy = { ...sourcePolicy, requirePlanApproval: false };
  }

  return clean;
}

function autonomyKey(userId: string, name: string): string {
  return sessionKey(['autonomy', userId, name]);
}

export function nowMs(): number {
  return Date.now();
}

function defaultConfig(userId: string): AutonomyConfig {
  const timestamp = nowMs();
  return {
    enabled: true,
    userId,
    mode: 'hybrid',
    runtime: 'dedicated_worker',
    actionPolicy: 'broad_autonomy',
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    maxRunsStored: 100,
    maxFeedItems: 200,
    feedDedupeEnabled: true,
    feedDedupeWindowDays: DEFAULT_DEDUPE_WINDOW_DAYS,
    sourcePolicy: {
      disabledSources: [],
      enabledSources: [],
      maxResearchToolCalls: 6,
      requirePlanApproval: false,
    },
    lastScheduledRunAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function getList<T>(userId: string, name: string): Promise<T[]> {
  const value = await jsonGet(autonomyKey(userId, name));
  return Array.isArray(value) ? value : [];
}

async function setValue(
  userId: string,
  name: string,
  value: unknown,
): Promise<void> {
  await jsonSet(autonomyKey(userId, name), '$', value);
}

export async function getConfig(userId: string): Promise<AutonomyConfig> {
  const existing = await jsonGet(autonomyKey(userId, 'config'));
  if (existing && typeof existing === 'object') {
    const defaults = defaultConfig(userId);
    const stored = existing as Partial<AutonomyConfig>;
    const storedSourcePolicy = sanitizeSourcePolicy(stored.sourcePolicy);
    return {
      ...defaults,
      ...stored,
      sourcePolicy: {
        ...defaults.sourcePolicy,
        ...(storedSourcePolicy || {}),
        requirePlanApproval: false,
      },
    };
  }
  const created = defaultConfig(userId);
  await setValue(userId, 'config', created);
  return created;
}

export async function saveConfig(
  userId: string,
  patch: Partial<AutonomyConfig>,
): Promise<AutonomyConfig> {
  const current = await getConfig(userId);
  const next: AutonomyConfig = {
    ...current,
    ...sanitizeConfigPatch(patch),
    userId,
    updatedAt: nowMs(),
  };
  await setValue(userId, 'config', next);
  await publishSyncEvent(userId, {
    type: 'autonomy_status',
    timestamp: nowMs(),
    data: { config: next },
  });
  return next;
}

export async function listGoals(userId: string): Promise<AutonomyGoal[]> {
  return getList<AutonomyGoal>(userId, 'goals');
}

export async function saveGoals(
  userId: string,
  goals: AutonomyGoal[],
): Promise<void> {
  await setValue(userId, 'goals', goals);
  await publishSyncEvent(userId, {
    type: 'autonomy_status',
    timestamp: nowMs(),
    data: { goals },
  });
}

function sanitizeGoalId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) return '';
  return cleaned.startsWith('goal_') ? cleaned : `goal_${cleaned}`;
}

function uniqueGoalId(preferredId: string, usedIds: Set<string>): string {
  const base = preferredId || `goal_${uuidv4().replace(/-/g, '')}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function sanitizeGoalTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = Array.from(
    new Set(
      value
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 12),
    ),
  );
  return tags.length > 0 ? tags : undefined;
}

export function normalizeImportedGoals(
  rawGoals: unknown[],
  existingGoals: AutonomyGoal[] = [],
): AutonomyGoal[] {
  const timestamp = nowMs();
  const usedIds = new Set(existingGoals.map((goal) => goal.id));

  return rawGoals
    .slice(0, MAX_IMPORTED_GOALS)
    .map((raw): AutonomyGoal | null => {
      if (!raw || typeof raw !== 'object') return null;
      const input = raw as Partial<AutonomyGoal> & Record<string, unknown>;
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title) return null;

      const priority = Number(input.priority);
      const status =
        typeof input.status === 'string' &&
        VALID_GOAL_STATUSES.has(input.status)
          ? (input.status as AutonomyGoal['status'])
          : 'active';
      const tags = sanitizeGoalTags(input.tags);
      return {
        id: uniqueGoalId(sanitizeGoalId(input.id), usedIds),
        title,
        description:
          typeof input.description === 'string' ? input.description.trim() : '',
        status,
        priority: Number.isFinite(priority) ? priority : 3,
        ...(tags ? { tags } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
        lastRunAt: null,
      };
    })
    .filter((goal): goal is AutonomyGoal => goal !== null);
}

export async function importGoals(
  userId: string,
  rawGoals: unknown[],
  mode: 'replace' | 'append' = 'replace',
): Promise<{ goals: AutonomyGoal[]; imported: number; skipped: number }> {
  const existingGoals = await listGoals(userId);
  const importedGoals = normalizeImportedGoals(
    rawGoals,
    mode === 'append' ? existingGoals : [],
  );
  const goals =
    mode === 'append' ? [...importedGoals, ...existingGoals] : importedGoals;
  await saveGoals(userId, goals);
  return {
    goals,
    imported: importedGoals.length,
    skipped: Math.max(0, rawGoals.length - importedGoals.length),
  };
}

export async function createGoal(
  userId: string,
  input: Pick<AutonomyGoal, 'title' | 'description'> & Partial<AutonomyGoal>,
): Promise<AutonomyGoal> {
  const timestamp = nowMs();
  const goal: AutonomyGoal = {
    id: `goal_${uuidv4().replace(/-/g, '')}`,
    title: input.title?.trim() || 'Untitled goal',
    description: input.description?.trim() || '',
    status: input.status || 'active',
    priority: Number.isFinite(input.priority) ? Number(input.priority) : 3,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastRunAt: null,
  };
  const goals = await listGoals(userId);
  goals.unshift(goal);
  await saveGoals(userId, goals);
  return goal;
}

export async function listRuns(userId: string): Promise<AutonomyRun[]> {
  return getList<AutonomyRun>(userId, 'runs');
}

function normalizeQueuedRequest(
  value: unknown,
  position: number,
): AutonomyQueuedRequest | null {
  if (!value || typeof value !== 'object') return null;
  const request = value as Partial<AutonomyQueuedRequest>;
  const id =
    typeof request.id === 'string' && request.id.trim()
      ? request.id
      : `queued_${position}`;

  return {
    id,
    trigger: typeof request.trigger === 'string' ? request.trigger : 'manual',
    goalId: typeof request.goalId === 'string' ? request.goalId : null,
    prompt: typeof request.prompt === 'string' ? request.prompt : '',
    requestedBy:
      typeof request.requestedBy === 'string' ? request.requestedBy : 'unknown',
    createdAt: Number.isFinite(request.createdAt)
      ? Number(request.createdAt)
      : 0,
    position,
  };
}

export async function listQueuedRequests(
  userId: string,
): Promise<AutonomyQueuedRequest[]> {
  const redis = getRedis();
  const rawItems = await redis.lrange(autonomyKey(userId, 'queue'), 0, -1);
  return rawItems
    .reverse()
    .map((raw, index) => {
      try {
        return normalizeQueuedRequest(JSON.parse(raw), index + 1);
      } catch {
        return null;
      }
    })
    .filter((request): request is AutonomyQueuedRequest => request !== null);
}

/**
 * Remove a request that is still queued.
 *
 * `cancelRun` keys on a run id, which the worker only mints at dequeue time, so
 * a queued request had no cancellation path at all: "run all active goals" can
 * enqueue up to MAX_QUEUE_DEPTH entries that the user could not withdraw.
 * LREM matches the exact serialized entry, so a concurrent dequeue of the same
 * item simply removes nothing and reports false.
 */
export async function cancelQueuedRequest(
  userId: string,
  requestId: string,
): Promise<boolean> {
  const trimmed = requestId?.trim();
  if (!trimmed) return false;

  const redis = getRedis();
  const queueKey = autonomyKey(userId, 'queue');
  const rawItems = await redis.lrange(queueKey, 0, -1);
  const match = rawItems.find((raw) => {
    try {
      return (JSON.parse(raw) as { id?: unknown })?.id === trimmed;
    } catch {
      return false;
    }
  });
  if (!match) return false;

  const removed = await redis.lrem(queueKey, 1, match);
  if (removed < 1) return false;

  await publishSyncEvent(userId, {
    type: 'autonomy_status',
    timestamp: nowMs(),
    data: { dequeued: trimmed },
  });
  return true;
}

export async function getRun(
  userId: string,
  runId: string,
): Promise<AutonomyRun | null> {
  return (await listRuns(userId)).find((run) => run.id === runId) || null;
}

// Bound the per-user autonomy queue so a stalled/slow worker cannot grow Redis
// without limit, and cap prompt size to keep queue entries small.
const MAX_QUEUE_DEPTH = positiveIntegerFromEnv('AUTONOMY_MAX_QUEUE_DEPTH', 100);
const MAX_PROMPT_CHARS = positiveIntegerFromEnv(
  'AUTONOMY_MAX_PROMPT_CHARS',
  8000,
);

export class QueueFullError extends Error {
  constructor(public readonly maxDepth: number) {
    super(
      `Autonomy queue is full (max ${maxDepth} pending requests). ` +
        'Try again once queued runs drain.',
    );
    this.name = 'QueueFullError';
  }
}

export class NoActiveGoalsError extends Error {
  constructor() {
    super('No active autonomy goals are available to run.');
    this.name = 'NoActiveGoalsError';
  }
}

type EnqueueRunInput = {
  trigger?: string;
  goalId?: string | null;
  prompt?: string;
  requestedBy?: string;
  scope?: string;
};

type QueueRequest = {
  id: string;
  trigger: string;
  goalId: string | null;
  prompt: string;
  requestedBy: string;
  createdAt: number;
};

function clippedPrompt(input: Pick<EnqueueRunInput, 'prompt'>): string {
  return (input.prompt || '').slice(0, MAX_PROMPT_CHARS);
}

function priorityValue(goal: AutonomyGoal): number {
  const priority = Number(goal.priority);
  return Number.isFinite(priority) ? priority : 3;
}

function isAllActiveGoalsPrompt(prompt: unknown): boolean {
  if (typeof prompt !== 'string') return false;
  const normalized = prompt
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!normalized) return false;
  if (
    /\b(do not|don't|dont|never|not|no)\b.*\b(run|start|queue)\b.*\b(all|every|each)\b.*\b(active\s+)?goals?\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  return /^(please\s+)?(run|start|queue)\s+(all|every|each)\s+(active\s+)?goals?(\s+now)?$/.test(
    normalized,
  );
}

export function isAllActiveGoalsRunRequest(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const request = input as EnqueueRunInput;
  if (request.scope === 'all_active_goals') return true;
  if (request.scope) return false;
  const trigger = request.trigger || 'manual';
  if (trigger !== 'manual') return false;
  return isAllActiveGoalsPrompt(request.prompt);
}

function newQueueRequest(
  input: EnqueueRunInput,
  queuedAt: number,
): QueueRequest {
  return {
    id: `request_${uuidv4().replace(/-/g, '')}`,
    trigger: input.trigger || (input.goalId ? 'goal' : 'manual'),
    goalId: input.goalId || null,
    prompt: clippedPrompt(input),
    requestedBy: input.requestedBy || 'ui',
    createdAt: queuedAt,
  };
}

export async function enqueueRun(
  userId: string,
  input: EnqueueRunInput,
): Promise<{ id: string; queuedAt: number }> {
  const redis = getRedis();
  const queueKey = autonomyKey(userId, 'queue');

  const depth = await redis.llen(queueKey);
  if (depth >= MAX_QUEUE_DEPTH) {
    throw new QueueFullError(MAX_QUEUE_DEPTH);
  }

  const queuedAt = nowMs();
  const request = newQueueRequest(input, queuedAt);
  await redis.lpush(queueKey, JSON.stringify(request));
  await publishSyncEvent(userId, {
    type: 'autonomy_status',
    timestamp: queuedAt,
    data: { queued: request },
  });
  return { id: request.id, queuedAt };
}

export async function enqueueAllActiveGoals(
  userId: string,
  input: Pick<EnqueueRunInput, 'prompt' | 'requestedBy'> = {},
): Promise<{
  queued: number;
  requests: Array<{ id: string; goalId: string; queuedAt: number }>;
}> {
  const goals = await listGoals(userId);
  const activeGoals = goals
    .map((goal, index) => ({ goal, index }))
    .filter(({ goal }) => goal.status === 'active')
    .sort(
      (a, b) =>
        priorityValue(a.goal) - priorityValue(b.goal) || a.index - b.index,
    )
    .map(({ goal }) => goal);

  if (!activeGoals.length) {
    throw new NoActiveGoalsError();
  }

  const redis = getRedis();
  const queueKey = autonomyKey(userId, 'queue');
  const depth = await redis.llen(queueKey);
  if (depth + activeGoals.length > MAX_QUEUE_DEPTH) {
    throw new QueueFullError(MAX_QUEUE_DEPTH);
  }

  const queuedAt = nowMs();
  const prompt = clippedPrompt(input);
  const requests = activeGoals.map((goal) =>
    newQueueRequest(
      {
        trigger: 'goal',
        goalId: goal.id,
        prompt,
        requestedBy: input.requestedBy || 'ui',
      },
      queuedAt,
    ),
  );

  await redis.lpush(
    queueKey,
    ...requests.map((request) => JSON.stringify(request)),
  );
  await publishSyncEvent(userId, {
    type: 'autonomy_status',
    timestamp: queuedAt,
    data: { queuedBatch: requests },
  });

  return {
    queued: requests.length,
    requests: requests.map((request) => ({
      id: request.id,
      goalId: request.goalId || '',
      queuedAt,
    })),
  };
}

export async function listEvents(
  userId: string,
  runId?: string,
): Promise<AutonomyEvent[]> {
  const events = await getList<AutonomyEvent>(userId, 'events');
  return runId ? events.filter((event) => event.runId === runId) : events;
}

export async function listFeed(userId: string): Promise<AutonomyFeedItem[]> {
  return getList<AutonomyFeedItem>(userId, 'feed');
}

// The worker caps AUTONOMY_REQUEST_TIMEOUT at 6900s, so the cancel flag must
// outlive the longest permitted run. At the previous 3600s it expired at
// exactly the default request timeout, letting a cancelled run finish and
// overwrite its own 'cancelled' status with 'completed'.
const CANCEL_FLAG_TTL_SECONDS = 2 * 6900;

export async function cancelRun(userId: string, runId: string): Promise<void> {
  const redis = getRedis();
  await redis.set(
    autonomyKey(userId, `cancel:${runId}`),
    '1',
    'EX',
    CANCEL_FLAG_TTL_SECONDS,
  );
  const runs = await listRuns(userId);
  const next = runs.map((run) =>
    run.id === runId && ['queued', 'running'].includes(run.status)
      ? {
          ...run,
          status: 'cancelled' as const,
          updatedAt: nowMs(),
          completedAt: nowMs(),
        }
      : run,
  );
  await setValue(userId, 'runs', next);
  await publishSyncEvent(userId, {
    type: 'autonomy_status',
    timestamp: nowMs(),
    data: { runId, status: 'cancelled' },
  });
}
