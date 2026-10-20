import { inferGoogleWorkspaceService } from '@/utils/app/googleWorkspace';
import { Logger } from '@/utils/logger';

import { FINALIZER_LOCK_TTL_MS, JOB_EXPIRY_SECONDS } from './constants';
import type { AsyncJobStatus, OAuthRequest } from './types';

import { getRedis, sessionKey } from '@/server/session/redis';
import { evalScript, redisScript } from '@/server/session/redisScript';
import { createHash } from 'node:crypto';

const logger = new Logger('AsyncJob');

// Redis key signalling that execution should stop. Cancellation and error
// finalization set it before claiming the terminal outcome.
export const abortKey = (jobId: string) =>
  sessionKey(['async-job-abort', jobId]);
export const finalizerLockKey = (jobId: string) =>
  sessionKey(['async-job-finalizer-lock', jobId]);
export const finalizationJournalKey = (jobId: string) =>
  sessionKey(['async-job-finalization', jobId]);

export interface JobFinalizationConversation {
  id: string;
  name: string;
  messages: any[];
  assistantMessageId: string;
  turnId?: string;
  content: string;
  intermediateSteps: any[];
  isPartial: boolean;
  error?: string;
  /** The user stopped this response; it is saved as stopped, not failed. */
  stopped?: boolean;
}

export interface JobFinalizationJournal {
  version: 1;
  state: 'pending' | 'completed';
  jobId: string;
  finalizationId: string;
  outcome: 'completed' | 'error';
  userId: string;
  finalizedAt: number;
  terminalStatus?: AsyncJobStatus;
  conversation?: JobFinalizationConversation;
  conversationAppliedAt?: number;
  conversationSuppressedAt?: number;
  memoryRetention?: {
    operationId: string;
    acceptedAt: number;
  };
  memoryRetentionAttemptedAt?: number;
  streamingStateClearedAt?: number;
  eventsPublishedAt?: number;
  streamStateClearedAt?: number;
  conversationGuardReleasedAt?: number;
  completedAt?: number;
}

export type NewJobFinalizationJournal = Omit<
  JobFinalizationJournal,
  | 'terminalStatus'
  | 'conversationAppliedAt'
  | 'conversationSuppressedAt'
  | 'memoryRetentionAttemptedAt'
  | 'streamingStateClearedAt'
  | 'eventsPublishedAt'
  | 'streamStateClearedAt'
  | 'conversationGuardReleasedAt'
  | 'completedAt'
>;

export type FinalizationJournalPhase =
  | 'conversationAppliedAt'
  | 'conversationSuppressedAt'
  | 'memoryRetentionAttemptedAt'
  | 'streamingStateClearedAt'
  | 'streamStateClearedAt'
  | 'conversationGuardReleasedAt'
  | 'completedAt';

export interface FinalizationEvent {
  channel: string;
  payload: string;
}

export function clearOAuthStatusFields(): Pick<
  AsyncJobStatus,
  'authUrl' | 'oauthState' | 'oauthRequests'
> {
  return {
    authUrl: undefined,
    oauthState: undefined,
    oauthRequests: undefined,
  };
}

/**
 * Reflect one successful browser OAuth callback in the durable job status.
 * The state value is already bound to this job by the trusted stream worker.
 * Remove only that request so parallel service authorizations remain visible.
 */
export async function completeOAuthJobRequest(
  jobId: string,
  oauthState: string,
): Promise<boolean> {
  if (!jobId || !oauthState) return false;
  return mutateLiveJobStatus(jobId, (currentStatus) => {
    const requests = Array.isArray(currentStatus.oauthRequests)
      ? currentStatus.oauthRequests
      : [];
    const matched =
      currentStatus.oauthState === oauthState ||
      requests.some((request) => request.oauthState === oauthState);
    if (!matched) return null;

    const remaining = requests.filter(
      (request) => request.oauthState !== oauthState,
    );
    const nextRequest = remaining[0];
    return {
      ...currentStatus,
      status: nextRequest ? 'oauth_required' : 'streaming',
      authUrl: nextRequest?.authUrl,
      oauthState: nextRequest?.oauthState,
      oauthRequests: remaining.length ? remaining : undefined,
      updatedAt: Date.now(),
    };
  });
}

/** Merge against the committed snapshot so a concurrent callback is not undone. */
export async function recordOAuthJobRequest(
  jobId: string,
  request: OAuthRequest,
): Promise<boolean> {
  return mutateLiveJobStatus(jobId, (current) => {
    const existing = Array.isArray(current.oauthRequests)
      ? current.oauthRequests
      : current.authUrl
      ? [
          {
            id: current.oauthState
              ? `${current.oauthState}:${current.authUrl}`
              : current.authUrl,
            authUrl: current.authUrl,
            oauthState: current.oauthState,
            service: inferGoogleWorkspaceService(current.authUrl),
          },
        ]
      : [];
    const requests = new Map(existing.map((item) => [item.id, item]));
    requests.set(request.id, request);
    return {
      ...current,
      status: 'oauth_required',
      authUrl: request.authUrl,
      oauthState: request.oauthState,
      oauthRequests: [...requests.values()],
      progress: 0,
      updatedAt: Date.now(),
    };
  });
}

/**
 * A status record is terminal once finalization stamped it or its status is
 * terminal. This is the TypeScript form of the checks the Lua scripts in this
 * module and in streamQueue make; every reader uses it so legacy records are
 * classified the same way everywhere.
 */
export function isTerminalStatusRecord(
  status: Pick<AsyncJobStatus, 'status' | 'finalizedAt'> | null | undefined,
): boolean {
  return Boolean(
    status &&
      (status.finalizedAt !== undefined || isTerminalJobStatus(status.status)),
  );
}

export function isTerminalJobStatus(status: AsyncJobStatus['status']): boolean {
  return status === 'completed' || status === 'error';
}

// Supports both RedisJSON documents and the plain-string fallback used when
// RedisJSON is unavailable. The read guard and compare-and-set write
// each execute atomically; a changed snapshot is re-read before retrying.
const READ_LIVE_JOB_STATUS_LUA = `
local type_reply = redis.call('TYPE', KEYS[1])
local key_type = type(type_reply) == 'table' and type_reply['ok'] or type_reply
if key_type == 'none' then
  return nil
end

local is_redis_json = string.find(string.lower(key_type), 'rejson', 1, true) ~= nil
local raw
if is_redis_json then
  raw = redis.call('JSON.GET', KEYS[1], '.')
elseif key_type == 'string' then
  raw = redis.call('GET', KEYS[1])
else
  return redis.error_reply('unsupported async job status key type: ' .. key_type)
end
if not raw then
  return nil
end

local ok_current, current = pcall(cjson.decode, raw)
if not ok_current or type(current) ~= 'table' then
  return redis.error_reply('invalid async job status JSON')
end
if current['finalizedAt'] ~= nil or current['status'] == 'completed' or current['status'] == 'error' then
  return nil
end

`;

// The winner may also take the finalizer lock in the same commit (KEYS[3],
// ARGV[5..6]) and finish the journal it just wrote without reading it back.
const CLAIM_TERMINAL_JOB_STATUS_LUA = `
-- CLAIM_TERMINAL_FINALIZATION
${READ_LIVE_JOB_STATUS_LUA}
if raw ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[3])
if is_redis_json then
  redis.call('JSON.SET', KEYS[1], '$', ARGV[2])
else
  redis.call('SET', KEYS[1], ARGV[2])
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
if #KEYS >= 3 and redis.call('SET', KEYS[3], ARGV[5], 'PX', ARGV[6], 'NX') then
  return 2
end
return 1
`;

// Keep journal JSON opaque in Lua: cjson loses empty-array types and rounds
// large exact integers. The snapshot comparison also fences competing phases;
// a digest avoids resending the journal and its conversation history.
//
// The journal commits first, then its events are published, then the cleanup
// it records runs. The receipt that the conversation was applied is therefore
// durable before any guard is released, a retry after a lost reply cannot
// publish twice, and nothing after the first write can fail the script: each
// cleanup is owner-checked, idempotent and protected with pcall (keys it
// misses expire on their own TTLs).
//
// KEYS[1] journal, then one key per cleanup (two for a retention submission).
// ARGV: digest, journal, TTL, user, conversation, job, cleanup count, each
// cleanup's name and arguments, then channel/payload pairs.
const UPDATE_FINALIZATION_JOURNAL_LUA = `
-- UPDATE_FINALIZATION_JOURNAL
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
if redis.sha1hex(raw) ~= ARGV[1] then return 0 end
local arity = {
  delete = 0, user_guard = 0, conversation_guard = 0, streaming_state = 0,
  retention = 3
}
local arg_index = 8
for _ = 1, tonumber(ARGV[7]) do
  local extra = arity[ARGV[arg_index]]
  if extra == nil then
    return redis.error_reply('unknown finalization cleanup')
  end
  arg_index = arg_index + 1 + extra
end
local events_from = arg_index
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
for index = events_from, #ARGV, 2 do
  redis.call('PUBLISH', ARGV[index], ARGV[index + 1])
end
local user_id, conversation_id, job_id = ARGV[4], ARGV[5], ARGV[6]
local function decoded(value)
  if type(value) ~= 'string' then return nil end
  local ok, result = pcall(cjson.decode, value)
  if ok and type(result) == 'table' then return result end
  return nil
end
local key_index = 2
arg_index = 8
for _ = 1, tonumber(ARGV[7]) do
  local name = ARGV[arg_index]
  local key = KEYS[key_index]
  arg_index = arg_index + 1
  key_index = key_index + 1
  if name == 'delete' then
    redis.pcall('DEL', key)
  elseif name == 'user_guard' then
    redis.pcall('ZREM', key, job_id)
  elseif name == 'conversation_guard' then
    local guard = decoded(redis.pcall('GET', key))
    if guard and guard['version'] == 1 and guard['userId'] == user_id
      and guard['conversationId'] == conversation_id
      and guard['jobId'] == job_id then
      redis.pcall('DEL', key)
    end
  elseif name == 'streaming_state' then
    local kind = redis.call('TYPE', key).ok
    local value = nil
    if kind == 'string' then
      value = redis.pcall('GET', key)
    elseif string.find(string.lower(kind), 'rejson', 1, true) then
      value = redis.pcall('JSON.GET', key, '.')
    end
    local state = decoded(value)
    if state and state['sessionId'] == job_id then redis.pcall('DEL', key) end
  elseif name == 'retention' then
    local queue = KEYS[key_index]
    key_index = key_index + 1
    redis.pcall('SET', key, ARGV[arg_index], 'EX', ARGV[arg_index + 1])
    redis.pcall('ZADD', queue, ARGV[arg_index + 2], job_id)
    arg_index = arg_index + 3
  end
end
return 1
`;

// One round trip replaces reading the journal, taking the lock and reading it
// again. Journals are written by JSON.stringify with this leading key order,
// so a completed one is recognized without a lock or transferring its body.
const COMPLETED_JOURNAL_PREFIX = '{"version":1,"state":"completed"';
// Status polls of finished jobs and worker acknowledgements run this, so
// evalScript sends only its digest once Redis has cached it.
const ACQUIRE_FINALIZATION = redisScript(`
-- ACQUIRE_FINALIZATION
local raw = redis.call('GET', KEYS[1])
if not raw then return {0} end
if string.sub(raw, 1, string.len(ARGV[3])) == ARGV[3] then return {2} end
if not redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2], 'NX') then
  return {3}
end
return {1, raw}
`);

const RELEASE_FINALIZATION_LOCK = redisScript(`
-- RELEASE_FINALIZATION_LOCK
if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end
`);

// Compare the exact stored snapshot and write the JS-serialized replacement.
// Lua decoding/re-encoding the entire document would turn empty JSON arrays
// into objects on plain Redis, corrupting nested status payloads.
const READ_JOB_STATUS_SNAPSHOT_LUA = `
-- READ_JOB_STATUS_SNAPSHOT
${READ_LIVE_JOB_STATUS_LUA}
return raw
`;

const UPDATE_LIVE_JOB_STATUS_LUA = `
-- UPDATE_LIVE_JOB_STATUS
${READ_LIVE_JOB_STATUS_LUA}
if raw ~= ARGV[1] then return 0 end
if is_redis_json then
  redis.call('JSON.SET', KEYS[1], '$', ARGV[2])
else
  redis.call('SET', KEYS[1], ARGV[2])
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
if ARGV[4] ~= '' then
  redis.pcall('PUBLISH', ARGV[4], ARGV[2])
end
return 1
`;

const DELETE_LIVE_JOB_STATUS_LUA = `
-- DELETE_LIVE_JOB_STATUS
${READ_LIVE_JOB_STATUS_LUA}
redis.call('DEL', KEYS[1])
return 1
`;

/**
 * Remove a status that never reached a terminal outcome. A terminal status is
 * kept: its finalization journal and polling clients still depend on it.
 */
export async function deleteLiveJobStatus(jobId: string): Promise<boolean> {
  const deleted = await getRedis().eval(
    DELETE_LIVE_JOB_STATUS_LUA,
    1,
    sessionKey(['async-job-status', jobId]),
  );
  return Number(deleted) === 1;
}

async function mutateLiveJobStatus(
  jobId: string,
  mutate: (current: AsyncJobStatus) => AsyncJobStatus | null,
  publish = true,
): Promise<boolean> {
  const client = getRedis();
  const statusKey = sessionKey(['async-job-status', jobId]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const snapshot = await client.eval(
      READ_JOB_STATUS_SNAPSHOT_LUA,
      1,
      statusKey,
    );
    if (typeof snapshot !== 'string') return false;
    const current = JSON.parse(snapshot) as AsyncJobStatus;
    const updated = mutate(current);
    if (!updated) return false;
    // An identical live snapshot is already persisted (for example duplicate
    // OAuth events in one clock tick). It is a successful receipt, not failure.
    if (JSON.stringify(updated) === JSON.stringify(current)) return true;
    const applied = await client.eval(
      UPDATE_LIVE_JOB_STATUS_LUA,
      1,
      statusKey,
      snapshot,
      JSON.stringify(updated),
      JOB_EXPIRY_SECONDS,
      publish ? `job:${jobId}:status` : '',
    );
    // Missing/terminal records return nil. Only a changed live snapshot retries.
    if (applied === null) return false;
    if (Number(applied) === 1) return true;
  }
  throw new Error(`Job ${jobId}: status changed during every update attempt`);
}

export async function updateJobStatus(
  jobId: string,
  updates: Partial<AsyncJobStatus>,
  options: { publish?: boolean } = {},
): Promise<void> {
  const isTerminalWrite =
    updates.status === 'completed' ||
    updates.status === 'error' ||
    updates.finalizedAt !== undefined;

  if (isTerminalWrite) {
    throw new Error(
      `Job ${jobId}: terminal updates must use claimTerminalJobStatus`,
    );
  }

  await mutateLiveJobStatus(
    jobId,
    (current) => ({ ...current, ...updates }),
    options.publish !== false,
  );
}

/** Content from one parallel tool does not resolve another tool's OAuth wait.
 * Derive progress from the same snapshot we replace, so a callback cannot be
 * undone by a worker that read its prompt just before the callback completed.
 */
export async function markJobStreaming(
  jobId: string,
  updatedAt: number,
): Promise<void> {
  await mutateLiveJobStatus(
    jobId,
    (current) => {
      const awaitingOAuth =
        current.status === 'oauth_required' &&
        (Boolean(current.authUrl) || Boolean(current.oauthRequests?.length));
      return {
        ...current,
        status: awaitingOAuth ? 'oauth_required' : 'streaming',
        ...(awaitingOAuth ? {} : clearOAuthStatusFields()),
        updatedAt,
      };
    },
    false,
  );
}

/** The live (non-terminal) status snapshot a terminal claim compares, or null. */
export async function readLiveJobStatusSnapshot(
  jobId: string,
): Promise<string | null> {
  const snapshot = await getRedis().eval(
    READ_JOB_STATUS_SNAPSHOT_LUA,
    1,
    sessionKey(['async-job-status', jobId]),
  );
  return typeof snapshot === 'string' ? snapshot : null;
}

export interface TerminalClaimOptions {
  /** A snapshot read concurrently with other finalization reads. */
  snapshot?: string | null;
  /** Take the finalizer lock with this token in the winning commit. */
  lockToken?: string;
}

export interface TerminalClaim {
  claimed: boolean;
  /** The journal this claim wrote, when it holds the finalizer lock. */
  lockedJournal?: JobFinalizationJournal;
}

/**
 * Atomically claim the only terminal transition for a job.
 *
 * Every completion path must call this before writing conversations or
 * publishing completion events. One Redis script compares the snapshot and
 * writes the terminal status and journal atomically across frontend pods. Once a terminal status or
 * finalizedAt is present, all later terminal contenders lose without changing
 * the stored result.
 */
export async function claimTerminalJobStatus(
  jobId: string,
  updates: Partial<AsyncJobStatus> & {
    status: 'completed' | 'error';
    finalizedAt: number;
  },
  journal: NewJobFinalizationJournal,
  options: TerminalClaimOptions = {},
): Promise<TerminalClaim> {
  if (
    journal.version !== 1 ||
    journal.jobId !== jobId ||
    journal.outcome !== updates.status ||
    journal.state !== 'pending' ||
    !journal.finalizationId ||
    journal.finalizedAt !== updates.finalizedAt
  ) {
    throw new Error(`Job ${jobId}: invalid terminal finalization journal`);
  }

  const client = getRedis();
  const statusKey = sessionKey(['async-job-status', jobId]);
  const lockKeys = options.lockToken ? [finalizerLockKey(jobId)] : [];
  const lockArgs = options.lockToken
    ? [options.lockToken, FINALIZER_LOCK_TTL_MS]
    : [];
  let snapshot: unknown =
    options.snapshot === undefined
      ? await readLiveJobStatusSnapshot(jobId)
      : options.snapshot;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt > 0) snapshot = await readLiveJobStatusSnapshot(jobId);
    if (typeof snapshot !== 'string') return { claimed: false };
    const terminalStatus: AsyncJobStatus = {
      ...JSON.parse(snapshot),
      ...updates,
    };
    // Freeze elapsed time with the winning terminal snapshot, before optional
    // memory retention and cleanup. This includes queue, agent, and tool time;
    // it is not a measure of token decoding throughput.
    const durationMs = updates.finalizedAt - terminalStatus.createdAt;
    if (
      updates.status === 'completed' &&
      Number.isFinite(durationMs) &&
      durationMs >= 0
    ) {
      terminalStatus.generationDurationMs = durationMs;
    }
    const written = JSON.stringify({ ...journal, terminalStatus });
    const result = await client.eval(
      CLAIM_TERMINAL_JOB_STATUS_LUA,
      2 + lockKeys.length,
      statusKey,
      finalizationJournalKey(jobId),
      ...lockKeys,
      snapshot,
      JSON.stringify(terminalStatus),
      JOB_EXPIRY_SECONDS,
      written,
      ...lockArgs,
    );
    if (result === null) return { claimed: false };
    if (Number(result) === 2) {
      const lockedJournal = { ...journal, terminalStatus };
      journalSnapshots.set(lockedJournal, written);
      return { claimed: true, lockedJournal };
    }
    if (Number(result) === 1) return { claimed: true };
  }
  throw new Error(
    `Job ${jobId}: status changed during every finalization attempt`,
  );
}

// The exact serialized journal each parsed or written copy came from. An
// update compares that snapshot's digest in Redis directly instead of reading
// the journal, which carries the conversation history, back first.
const journalSnapshots = new WeakMap<JobFinalizationJournal, string>();

function parseFinalizationJournal(
  jobId: string,
  raw: string,
): JobFinalizationJournal {
  let journal: JobFinalizationJournal;
  try {
    journal = JSON.parse(raw) as JobFinalizationJournal;
  } catch (error) {
    logger.error(`Job ${jobId}: failed to parse finalization journal`, error);
    throw error;
  }
  if (
    journal.version !== 1 ||
    journal.jobId !== jobId ||
    typeof journal.finalizationId !== 'string' ||
    !journal.finalizationId
  ) {
    throw new Error(`Job ${jobId}: invalid finalization journal`);
  }
  journalSnapshots.set(journal, raw);
  return journal;
}

export type FinalizationAcquisition =
  | { state: 'missing' }
  | { state: 'completed' }
  | { state: 'busy' }
  | { state: 'locked'; journal: JobFinalizationJournal };

/**
 * Take the finalizer lock and read the journal in one round trip. A missing
 * or completed journal takes no lock; a completed one is not transferred.
 */
export async function acquireFinalization(
  jobId: string,
  lockToken: string,
): Promise<FinalizationAcquisition> {
  const [code, raw] = (await evalScript(
    getRedis(),
    ACQUIRE_FINALIZATION,
    2,
    finalizationJournalKey(jobId),
    finalizerLockKey(jobId),
    lockToken,
    FINALIZER_LOCK_TTL_MS,
    COMPLETED_JOURNAL_PREFIX,
  )) as [number, string?];
  if (Number(code) === 0) return { state: 'missing' };
  if (Number(code) === 2) return { state: 'completed' };
  if (Number(code) === 3) return { state: 'busy' };
  try {
    return {
      state: 'locked',
      journal: parseFinalizationJournal(jobId, String(raw)),
    };
  } catch (error) {
    await releaseFinalizationLock(jobId, lockToken).catch(() => undefined);
    throw error;
  }
}

export async function releaseFinalizationLock(
  jobId: string,
  lockToken: string,
): Promise<void> {
  await evalScript(
    getRedis(),
    RELEASE_FINALIZATION_LOCK,
    1,
    finalizerLockKey(jobId),
    lockToken,
  );
}

/**
 * A Redis effect committed by the journal write that records it: an
 * owner-checked release or deletion, or a memory retention submission.
 */
export type FinalizationEffect =
  | { kind: 'delete'; key: string }
  | { kind: 'user_guard'; key: string }
  | { kind: 'conversation_guard'; key: string }
  | { kind: 'streaming_state'; key: string }
  | {
      kind: 'retention';
      key: string;
      queueKey: string;
      value: string;
      ttlSeconds: number;
      dueAt: number;
    };

export interface FinalizationJournalUpdate {
  phases?: FinalizationJournalPhase[];
  /** Published once, by the write that records eventsPublishedAt. */
  events?: FinalizationEvent[];
  effects?: FinalizationEffect[];
}

function recordPhases(
  journal: JobFinalizationJournal,
  phases: FinalizationJournalPhase[],
  at: number,
): void {
  for (const phase of phases) {
    if (journal[phase] === undefined) journal[phase] = at;
    if (phase === 'completedAt') journal.state = 'completed';
  }
}

/**
 * Apply one update to the journal. `plan` sees the committed journal on every
 * attempt, so a retry after a concurrent change never repeats a publication
 * or records a phase whose effect it did not include.
 */
export async function updateFinalizationJournal(
  jobId: string,
  finalizationId: string,
  plan: (journal: JobFinalizationJournal) => FinalizationJournalUpdate,
  at: number = Date.now(),
  known?: JobFinalizationJournal,
): Promise<JobFinalizationJournal | null> {
  const client = getRedis();
  const key = finalizationJournalKey(jobId);
  let snapshot =
    known && known.finalizationId === finalizationId
      ? journalSnapshots.get(known) ?? null
      : null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (snapshot === null) {
      snapshot = await client.get(key);
      if (!snapshot) return null;
    }
    const journal = parseFinalizationJournal(jobId, snapshot);
    if (journal.finalizationId !== finalizationId) return null;
    const original = JSON.stringify(journal);
    const update = plan(journal);
    const events =
      update.events?.length && journal.eventsPublishedAt === undefined
        ? update.events
        : [];
    recordPhases(journal, update.phases ?? [], at);
    if (events.length) journal.eventsPublishedAt = at;
    const updated = JSON.stringify(journal);
    if (updated === original) return journal;
    const effects = update.effects ?? [];
    const keys = effects.flatMap((effect) =>
      effect.kind === 'retention'
        ? [effect.key, effect.queueKey]
        : [effect.key],
    );
    const effectArgs = effects.flatMap((effect) =>
      effect.kind === 'retention'
        ? [effect.kind, effect.value, effect.ttlSeconds, effect.dueAt]
        : [effect.kind],
    );
    const result = await client.eval(
      UPDATE_FINALIZATION_JOURNAL_LUA,
      1 + keys.length,
      key,
      ...keys,
      createHash('sha1').update(snapshot).digest('hex'),
      updated,
      JOB_EXPIRY_SECONDS,
      journal.userId,
      journal.conversation?.id ?? '',
      jobId,
      effects.length,
      ...effectArgs,
      ...events.flatMap((event) => [event.channel, event.payload]),
    );
    if (result === null) return null;
    if (Number(result) === 1) {
      journalSnapshots.set(journal, updated);
      return journal;
    }
    snapshot = null;
  }
  throw new Error(`Job ${jobId}: journal changed during every update attempt`);
}
