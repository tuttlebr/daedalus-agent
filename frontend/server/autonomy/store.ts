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

import { sanitizeSourcePolicy } from '@/server/chat/sourcePolicy';
import { positiveIntegerFromEnv } from '@/server/config/env';
import { getRedis, jsonGet, jsonSet, sessionKey } from '@/server/session/redis';
import { createHash, randomBytes } from 'node:crypto';
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
const APPROVAL_RESOLUTION_TTL_SECONDS = 7 * 24 * 60 * 60;

function pendingApprovalKey(userId: string, requestId: string): string {
  const safeUser = createHash('sha256')
    .update(userId.trim())
    .digest('hex')
    .slice(0, 16);
  return `approval-pending:${safeUser}:${requestId.trim()}`;
}

type PendingMcpApproval = {
  request_id: string;
  user_id: string;
  action_type: 'mcp_mutation';
  action: string;
  reason: string;
  target: string;
  server_name: string;
  tool_name: string;
  canonical_arguments: string;
  arguments_preview: string;
  arguments_sha256: string;
};

type ApprovalExecution = {
  approvalId: string;
  actionType: string;
  action: string;
  target: string;
  serverName?: string;
  toolName?: string;
  canonicalArguments?: string;
  argumentsSha256?: string;
  originalPrompt?: string;
};

type ApprovalResolutionMarker = {
  status: 'approved' | 'denied';
  approval: AutonomyApproval;
  requestId?: string;
};

async function loadPendingMcpApproval(
  userId: string,
  approval: AutonomyApproval,
): Promise<PendingMcpApproval> {
  const requestId = approval.approvalRequestId?.trim();
  if (!requestId) {
    throw new Error('MCP approval is missing its protected request id');
  }
  const raw = await getRedis().get(pendingApprovalKey(userId, requestId));
  if (!raw) {
    throw new Error('MCP approval intent is missing or expired');
  }

  let pending: PendingMcpApproval;
  try {
    pending = JSON.parse(raw) as PendingMcpApproval;
  } catch {
    throw new Error('MCP approval intent is invalid');
  }
  const canonicalHash = createHash('sha256')
    .update(pending.canonical_arguments || '')
    .digest('hex');
  if (
    pending.request_id !== requestId ||
    pending.user_id !== userId.trim() ||
    pending.action_type !== 'mcp_mutation' ||
    !pending.target ||
    pending.target === '*' ||
    !pending.server_name ||
    !pending.tool_name ||
    !pending.canonical_arguments ||
    canonicalHash !== pending.arguments_sha256
  ) {
    throw new Error('MCP approval intent failed integrity validation');
  }
  return pending;
}

function approvalResolutionKey(userId: string, approvalId: string): string {
  return autonomyKey(userId, `approval-resolution:${approvalId}`);
}

function parseApprovalResolutionMarker(
  raw: unknown,
  approvalId: string,
): ApprovalResolutionMarker | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const marker = JSON.parse(raw) as ApprovalResolutionMarker;
    if (
      !['approved', 'denied'].includes(marker.status) ||
      marker.approval?.id !== approvalId ||
      marker.approval?.status !== marker.status
    ) {
      return null;
    }
    return marker;
  } catch {
    return null;
  }
}

async function commitApprovalResolution(
  userId: string,
  approvalId: string,
  marker: ApprovalResolutionMarker,
  request: QueueRequest | null,
  execution: ApprovalExecution | undefined,
  pendingRequestId?: string,
): Promise<ApprovalResolutionMarker> {
  const redis = getRedis();
  const markerKey = approvalResolutionKey(userId, approvalId);
  const requestId = request?.id || marker.requestId || approvalId;
  const executionKey = autonomyKey(userId, `approval-execution:${requestId}`);
  const queueKey = autonomyKey(userId, 'queue');
  const approvalsKey = autonomyKey(userId, 'approvals');
  const pendingKey = pendingRequestId
    ? pendingApprovalKey(userId, pendingRequestId)
    : markerKey;
  const markerJson = JSON.stringify(marker);
  const executionJson = execution ? JSON.stringify(execution) : '';
  const requestJson = request ? JSON.stringify(request) : '';

  const result = (await redis.eval(
    `
      local function key_type(key)
        local value = redis.call('TYPE', key)
        if type(value) == 'table' then return value['ok'] end
        return value
      end
      local function update_approval(raw_approval)
        local approval_type = key_type(KEYS[5])
        local raw_approvals
        if approval_type == 'string' then
          raw_approvals = redis.call('GET', KEYS[5])
        elseif approval_type == 'none' then
          return redis.error_reply('approval projection is missing')
        elseif string.find(string.lower(approval_type), 'rejson') then
          raw_approvals = redis.call('JSON.GET', KEYS[5])
        else
          return redis.error_reply('approval projection has incompatible type')
        end
        local approvals = cjson.decode(raw_approvals or '[]')
        local replacement = cjson.decode(raw_approval)
        local found = false
        for index, approval in ipairs(approvals) do
          if approval['id'] == ARGV[7] then
            approvals[index] = replacement
            found = true
            break
          end
        end
        if not found then return redis.error_reply('approval projection entry is missing') end
        local encoded = cjson.encode(approvals)
        if approval_type == 'string' then
          redis.call('SET', KEYS[5], encoded)
        else
          redis.call('JSON.SET', KEYS[5], '$', encoded)
        end
      end

      local existing = redis.call('GET', KEYS[1])
      if existing then
        local existing_marker = cjson.decode(existing)
        update_approval(cjson.encode(existing_marker['approval']))
        return {0, existing}
      end

      local marker_type = key_type(KEYS[1])
      local execution_type = key_type(KEYS[2])
      local queue_type = key_type(KEYS[3])
      local pending_type = key_type(KEYS[4])
      if marker_type ~= 'none' and marker_type ~= 'string' then
        return redis.error_reply('approval marker key has incompatible type')
      end
      if execution_type ~= 'none' and execution_type ~= 'string' then
        return redis.error_reply('approval execution key has incompatible type')
      end
      if queue_type ~= 'none' and queue_type ~= 'list' then
        return redis.error_reply('approval queue key has incompatible type')
      end
      if ARGV[6] == '1' and pending_type ~= 'none' and pending_type ~= 'string' then
        return redis.error_reply('pending approval key has incompatible type')
      end

      update_approval(ARGV[8])
      redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4], 'NX')
      if ARGV[2] ~= '' then
        redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[5])
      end
      if ARGV[3] ~= '' then redis.call('LPUSH', KEYS[3], ARGV[3]) end
      if ARGV[6] == '1' then redis.call('DEL', KEYS[4]) end
      return {1, ARGV[1]}
    `,
    5,
    markerKey,
    executionKey,
    queueKey,
    pendingKey,
    approvalsKey,
    markerJson,
    executionJson,
    requestJson,
    APPROVAL_RESOLUTION_TTL_SECONDS,
    APPROVAL_RESOLUTION_TTL_SECONDS,
    pendingRequestId ? '1' : '0',
    approvalId,
    JSON.stringify(marker.approval),
  )) as [number | string, string];

  const committed = parseApprovalResolutionMarker(result?.[1], approvalId);
  if (!committed) throw new Error('Approval resolution commit was invalid');
  return committed;
}

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
  if (sourcePolicy) clean.sourcePolicy = sourcePolicy;

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
    feedDedupeEnabled: true,
    feedDedupeWindowDays: DEFAULT_DEDUPE_WINDOW_DAYS,
    sourcePolicy: {
      disabledSources: [],
      enabledSources: [],
      maxResearchToolCalls: 6,
      requirePlanApproval: true,
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
  approvalId?: string;
  actionType?: string;
};

type QueueRequest = {
  id: string;
  trigger: string;
  goalId: string | null;
  prompt: string;
  requestedBy: string;
  createdAt: number;
  approvalId?: string;
  actionType?: string;
};

function clippedPrompt(input: Pick<EnqueueRunInput, 'prompt'>): string {
  return (input.prompt || '').slice(0, MAX_PROMPT_CHARS);
}

function priorityValue(goal: AutonomyGoal): number {
  const priority = Number(goal.priority);
  return Number.isFinite(priority) ? priority : 3;
}

export function isAllActiveGoalsPrompt(prompt: unknown): boolean {
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
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    ...(input.actionType ? { actionType: input.actionType } : {}),
  };
}

export async function enqueueRun(
  userId: string,
  input: EnqueueRunInput,
  options: {
    enforceDepthCap?: boolean;
  } = {},
): Promise<{ id: string; queuedAt: number }> {
  const redis = getRedis();
  const queueKey = autonomyKey(userId, 'queue');

  // Apply backpressure on the user-facing enqueue path only; internal
  // continuations (e.g. approval re-enqueue) must not be dropped when deep.
  if (options.enforceDepthCap) {
    const depth = await redis.llen(queueKey);
    if (depth >= MAX_QUEUE_DEPTH) {
      throw new QueueFullError(MAX_QUEUE_DEPTH);
    }
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
  options: { enforceDepthCap?: boolean } = {},
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
  if (options.enforceDepthCap) {
    const depth = await redis.llen(queueKey);
    if (depth + activeGoals.length > MAX_QUEUE_DEPTH) {
      throw new QueueFullError(MAX_QUEUE_DEPTH);
    }
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

export async function listApprovals(
  userId: string,
): Promise<AutonomyApproval[]> {
  return getList<AutonomyApproval>(userId, 'approvals');
}

export class ApprovalDecisionInProgressError extends Error {
  constructor() {
    super('This approval decision is already being processed.');
    this.name = 'ApprovalDecisionInProgressError';
  }
}

async function updateApprovalWithLockHeld(
  userId: string,
  approvalId: string,
  status: 'approved' | 'denied',
): Promise<AutonomyApproval | null> {
  const approvals = await listApprovals(userId);
  const index = approvals.findIndex((approval) => approval.id === approvalId);
  if (index === -1) return null;

  const pending = approvals[index];
  // A decision is a one-way state transition. In particular, a repeated
  // approval must never mint another executable credential or enqueue a
  // second resumed run.
  if (pending.status !== 'pending') return pending;

  const existingMarker = parseApprovalResolutionMarker(
    await getRedis().get(approvalResolutionKey(userId, approvalId)),
    approvalId,
  );
  if (existingMarker) {
    const repaired = await commitApprovalResolution(
      userId,
      approvalId,
      existingMarker,
      null,
      undefined,
    );
    approvals[index] = repaired.approval;
    await publishSyncEvent(userId, {
      type: 'autonomy_status',
      timestamp: nowMs(),
      data: { approval: approvals[index] },
    }).catch(() => {});
    return approvals[index];
  }

  const isOAuthAuthorization = pending.actionType === 'oauth_authorization';
  const isResearchPlan = pending.actionType === 'deep_research_plan';
  let approvalExecution: ApprovalExecution | undefined;
  let approvedRecord = pending;
  if (status === 'approved' && !isOAuthAuthorization && !isResearchPlan) {
    if (pending.actionType === 'mcp_mutation') {
      const intent = await loadPendingMcpApproval(userId, pending);
      approvedRecord = {
        ...pending,
        action: intent.action,
        reason: intent.reason,
        target: intent.target,
        serverName: intent.server_name,
        toolName: intent.tool_name,
        approvalRequestId: intent.request_id,
        argumentsPreview: intent.arguments_preview,
        argumentsSha256: intent.arguments_sha256,
      };
      approvalExecution = {
        approvalId: pending.id,
        actionType: 'mcp_mutation',
        action: intent.action,
        target: intent.target,
        serverName: intent.server_name,
        toolName: intent.tool_name,
        canonicalArguments: intent.canonical_arguments,
        argumentsSha256: intent.arguments_sha256,
      };
    } else {
      approvalExecution = {
        approvalId: pending.id,
        actionType: pending.actionType,
        action: pending.action,
        target: pending.target || '',
      };
    }
  }

  approvals[index] = {
    ...approvedRecord,
    status,
    resolvedAt: nowMs(),
  };

  let queuedRequest: QueueRequest | null = null;
  if (status === 'approved') {
    const approved = approvals[index];
    const pausedRun = (await listRuns(userId)).find(
      (run) => run.id === approved.runId,
    );
    const originalPrompt = pausedRun?.prompt?.trim();
    if (approvalExecution && originalPrompt) {
      approvalExecution.originalPrompt = originalPrompt;
    }
    const prompt = isOAuthAuthorization
      ? (
          `OAuth authorization has been completed for target ${
            approved.target || '*'
          }. ` +
          `Retry the paused autonomous run ${approved.runId}. ` +
          (originalPrompt ? `Original manual prompt: ${originalPrompt}` : '')
        ).trim()
      : `Continue the paused autonomous run ${approved.runId}. ` +
        `The user approved the displayed ${approved.actionType} action ` +
        `for target ${approved.target || '*'}. ` +
        (approvalExecution
          ? 'The worker will supply the scoped execution context privately.'
          : 'Proceed only if the backend can validate approval.') +
        (!approvalExecution && originalPrompt
          ? ` Original manual prompt: ${originalPrompt}`
          : '');

    queuedRequest = newQueueRequest(
      {
        trigger: 'approval',
        requestedBy: 'ui',
        prompt,
        approvalId: approved.id,
        actionType: approved.actionType,
      },
      nowMs(),
    );
  }

  const committed = await commitApprovalResolution(
    userId,
    approvalId,
    {
      status,
      approval: approvals[index],
      ...(queuedRequest ? { requestId: queuedRequest.id } : {}),
    },
    queuedRequest,
    approvalExecution,
    pending.actionType === 'mcp_mutation'
      ? pending.approvalRequestId
      : undefined,
  );
  approvals[index] = committed.approval;

  // The executable continuation, decision marker, exact public-record update,
  // queue entry, and protected pending-intent deletion commit in one script.
  // The script reads the latest approval list, so concurrent worker appends are
  // preserved instead of being overwritten by a stale whole-list projection.

  await publishSyncEvent(userId, {
    type: 'autonomy_status',
    timestamp: nowMs(),
    data: { approval: approvals[index] },
  }).catch(() => {});
  if (queuedRequest) {
    await publishSyncEvent(userId, {
      type: 'autonomy_status',
      timestamp: queuedRequest.createdAt,
      data: { queued: queuedRequest },
    }).catch(() => {});
  }

  return approvals[index];
}

export async function updateApproval(
  userId: string,
  approvalId: string,
  status: 'approved' | 'denied',
): Promise<AutonomyApproval | null> {
  const redis = getRedis();
  const lockKey = autonomyKey(userId, `approval-decision:${approvalId}`);
  const lockOwner = randomBytes(16).toString('base64url');
  const acquired = await redis.set(lockKey, lockOwner, 'EX', 15, 'NX');
  if (acquired !== 'OK') throw new ApprovalDecisionInProgressError();

  try {
    return await updateApprovalWithLockHeld(userId, approvalId, status);
  } finally {
    await redis.eval(
      "if redis.call('GET',KEYS[1]) == ARGV[1] then " +
        "return redis.call('DEL',KEYS[1]) else return 0 end",
      1,
      lockKey,
      lockOwner,
    );
  }
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
