import { publishSyncEvent } from '@/utils/sync/publish';

import {
  AutonomyApproval,
  AutonomyConfig,
  AutonomyEvent,
  AutonomyFeedItem,
  AutonomyGoal,
  AutonomyQueuedRequest,
  AutonomyRun,
} from '@/types/autonomy';

import { getRedis, jsonGet, jsonSet, sessionKey } from '@/server/session/redis';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_INTERVAL_SECONDS = 14_400;
const MIN_INTERVAL_SECONDS = 300; // 5 min floor — block degenerate tight worker loops
const MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const VALID_MODES = new Set(['hybrid', 'research_feed', 'task_executor']);
const VALID_RUNTIMES = new Set(['dedicated_worker']);
const VALID_ACTION_POLICIES = new Set([
  'broad_autonomy',
  'read_memory_only',
  'low_risk_writes',
]);

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

  return clean;
}

export function autonomyKey(userId: string, name: string): string {
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
    return { ...defaultConfig(userId), ...existing };
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

export async function getRun(
  userId: string,
  runId: string,
): Promise<AutonomyRun | null> {
  return (await listRuns(userId)).find((run) => run.id === runId) || null;
}

export async function enqueueRun(
  userId: string,
  input: {
    trigger?: string;
    goalId?: string | null;
    prompt?: string;
    requestedBy?: string;
  },
): Promise<{ id: string; queuedAt: number }> {
  const queuedAt = nowMs();
  const request = {
    id: `request_${uuidv4().replace(/-/g, '')}`,
    trigger: input.trigger || (input.goalId ? 'goal' : 'manual'),
    goalId: input.goalId || null,
    prompt: input.prompt || '',
    requestedBy: input.requestedBy || 'ui',
    createdAt: queuedAt,
  };
  const redis = getRedis();
  await redis.lpush(autonomyKey(userId, 'queue'), JSON.stringify(request));
  await publishSyncEvent(userId, {
    type: 'autonomy_status',
    timestamp: queuedAt,
    data: { queued: request },
  });
  return { id: request.id, queuedAt };
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

export async function listApprovals(
  userId: string,
): Promise<AutonomyApproval[]> {
  return getList<AutonomyApproval>(userId, 'approvals');
}

export async function updateApproval(
  userId: string,
  approvalId: string,
  status: 'approved' | 'denied',
): Promise<AutonomyApproval | null> {
  const approvals = await listApprovals(userId);
  const index = approvals.findIndex((approval) => approval.id === approvalId);
  if (index === -1) return null;

  approvals[index] = {
    ...approvals[index],
    status,
    resolvedAt: nowMs(),
  };
  await setValue(userId, 'approvals', approvals);

  if (status === 'approved') {
    const approved = approvals[index];
    const pausedRun = (await listRuns(userId)).find(
      (run) => run.id === approved.runId,
    );
    const isOAuthAuthorization = approved.actionType === 'oauth_authorization';
    const originalPrompt = pausedRun?.prompt?.trim();
    const prompt = isOAuthAuthorization
      ? (
          `OAuth authorization has been completed for target ${
            approved.target || '*'
          }. ` +
          `Retry the paused autonomous run ${approved.runId}. ` +
          (originalPrompt ? `Original manual prompt: ${originalPrompt}` : '')
        ).trim()
      : `Continue the paused autonomous run ${approved.runId}. ` +
        `The user approved action ${approved.actionType} ` +
        `for target ${approved.target || '*'}. ` +
        (approved.approvalToken
          ? `Use approval_token="${approved.approvalToken}".`
          : 'Proceed only if the backend can validate approval.');

    await enqueueRun(userId, {
      trigger: 'approval',
      requestedBy: 'ui',
      prompt,
    });
  }

  await publishSyncEvent(userId, {
    type: 'autonomy_status',
    timestamp: nowMs(),
    data: { approval: approvals[index] },
  });

  return approvals[index];
}

export async function cancelRun(userId: string, runId: string): Promise<void> {
  const redis = getRedis();
  await redis.set(autonomyKey(userId, `cancel:${runId}`), '1', 'EX', 3600);
  const runs = await listRuns(userId);
  const next = runs.map((run) =>
    run.id === runId &&
    ['queued', 'running', 'waiting_approval'].includes(run.status)
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
