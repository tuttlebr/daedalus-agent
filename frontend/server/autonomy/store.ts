import { v4 as uuidv4 } from 'uuid';

import {
  getRedis,
  jsonGet,
  jsonSet,
  sessionKey,
} from '@/server/session/redis';
import {
  AutonomyApproval,
  AutonomyConfig,
  AutonomyEvent,
  AutonomyFeedItem,
  AutonomyGoal,
  AutonomyQueuedRequest,
  AutonomyRun,
} from '@/types/autonomy';
import { publishSyncEvent } from '@/utils/sync/publish';

const DEFAULT_INTERVAL_SECONDS = 14_400;

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

async function setValue(userId: string, name: string, value: unknown): Promise<void> {
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
    ...patch,
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
  const id = typeof request.id === 'string' && request.id.trim()
    ? request.id
    : `queued_${position}`;

  return {
    id,
    trigger: typeof request.trigger === 'string' ? request.trigger : 'manual',
    goalId: typeof request.goalId === 'string' ? request.goalId : null,
    prompt: typeof request.prompt === 'string' ? request.prompt : '',
    requestedBy: typeof request.requestedBy === 'string'
      ? request.requestedBy
      : 'unknown',
    createdAt: Number.isFinite(request.createdAt) ? Number(request.createdAt) : 0,
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
        `OAuth authorization has been completed for target ${approved.target || '*'}. ` +
        `Retry the paused autonomous run ${approved.runId}. ` +
        (originalPrompt ? `Original manual prompt: ${originalPrompt}` : '')
      ).trim()
      : (
        `Continue the paused autonomous run ${approved.runId}. ` +
        `The user approved action ${approved.actionType} ` +
        `for target ${approved.target || '*'}. ` +
        (approved.approvalToken
          ? `Use approval_token="${approved.approvalToken}".`
          : 'Proceed only if the backend can validate approval.')
      );

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
    run.id === runId && ['queued', 'running', 'waiting_approval'].includes(run.status)
      ? { ...run, status: 'cancelled' as const, updatedAt: nowMs(), completedAt: nowMs() }
      : run,
  );
  await setValue(userId, 'runs', next);
  await publishSyncEvent(userId, {
    type: 'autonomy_status',
    timestamp: nowMs(),
    data: { runId, status: 'cancelled' },
  });
}
