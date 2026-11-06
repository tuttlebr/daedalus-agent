import { COMPAT_LIMITS } from './config';
import {
  type CompatErrorDetails,
  type CompatErrorKind,
  invalidRequest,
} from './errors';

import type { RunUsage } from '@/server/chat/types';
import { getRedis, sessionKey } from '@/server/session/redis';
import { evalScript, redisScript } from '@/server/session/redisScript';
import { createHash } from 'node:crypto';

/**
 * `Idempotency-Key` support for compatibility API submissions.
 *
 * A key is scoped to the authenticated account and route. Before a job is
 * queued it is bound, atomically, to a hash of the whole request and the job
 * ID. Repeating the key then never starts another run during the retention
 * window: an identical request attaches to the live run or replays its
 * retained outcome, a different request is a conflict, and a run whose
 * outcome was never recorded is reported as unknown instead of re-executed.
 *
 * Retention covers the longest run (30 minutes plus queueing) and SDK retry
 * backoff with a wide margin.
 */
export const IDEMPOTENCY_RETENTION_SECONDS = 24 * 60 * 60;

const KEY_PATTERN = /^[\x21-\x7e]+$/;

export type StoredOutcome =
  | { kind: 'completed'; text: string; truncated: boolean; usage?: RunUsage }
  | {
      kind: 'error';
      error: {
        kind: CompatErrorKind;
        message: string;
        code?: string;
        details?: CompatErrorDetails;
      };
    };

export interface IdempotencyRecord {
  version: 1;
  requestHash: string;
  jobId: string;
  /** `uncertain`: the queue commit's result was lost; never replayed. */
  state: 'running' | 'completed' | 'failed' | 'uncertain';
  createdAt: number;
  outcome?: StoredOutcome;
}

export type IdempotencyClaim =
  | { kind: 'claimed' }
  | { kind: 'mismatch'; record: IdempotencyRecord }
  | { kind: 'existing'; record: IdempotencyRecord };

export function validateIdempotencyKey(value: unknown): string | null {
  if (value === undefined) return null;
  const key = Array.isArray(value) ? value[0] : value;
  if (
    typeof key !== 'string' ||
    !key ||
    key.length > COMPAT_LIMITS.maxIdempotencyKeyLength ||
    !KEY_PATTERN.test(key)
  ) {
    throw invalidRequest(
      `Idempotency-Key must be 1-${COMPAT_LIMITS.maxIdempotencyKeyLength} printable ASCII characters.`,
      'Idempotency-Key',
    );
  }
  return key;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

/** Any difference in the body or conversation link is a different request. */
export function hashCompatRequest(
  route: string,
  body: unknown,
  conversationId: string | null,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ route, body, conversationId })))
    .digest('hex');
}

function recordKey(username: string, route: string, key: string): string {
  const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  return sessionKey([
    'api-idempotency',
    digest(username).slice(0, 32),
    route,
    digest(key),
  ]);
}

function parseRecord(raw: unknown): IdempotencyRecord | null {
  if (typeof raw !== 'string') return null;
  try {
    const record = JSON.parse(raw) as IdempotencyRecord;
    return record?.version === 1 && typeof record.jobId === 'string'
      ? record
      : null;
  } catch {
    return null;
  }
}

// KEYS: record. ARGV: record JSON, ttl.
const CLAIM_IDEMPOTENCY_KEY = redisScript(`
-- CLAIM_IDEMPOTENCY_KEY
local existing = redis.call('GET', KEYS[1])
if existing then return existing end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
return false
`);

// KEYS: record. ARGV: job ID, new state, outcome JSON or ''.
const SETTLE_IDEMPOTENCY_KEY = redisScript(`
-- SETTLE_IDEMPOTENCY_KEY
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' or record['jobId'] ~= ARGV[1] then
  return 0
end
if record['state'] ~= 'running' and record['state'] ~= 'uncertain' then
  return 0
end
record['state'] = ARGV[2]
if ARGV[3] ~= '' then record['outcome'] = cjson.decode(ARGV[3]) end
redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
return 1
`);

// KEYS: record. ARGV: job ID.
const RELEASE_IDEMPOTENCY_KEY = redisScript(`
-- RELEASE_IDEMPOTENCY_KEY
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, record = pcall(cjson.decode, raw)
if ok and type(record) == 'table' and record['jobId'] == ARGV[1]
  and record['state'] == 'running' then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`);

export async function claimIdempotencyKey(
  username: string,
  route: string,
  key: string,
  requestHash: string,
  jobId: string,
): Promise<IdempotencyClaim> {
  const record: IdempotencyRecord = {
    version: 1,
    requestHash,
    jobId,
    state: 'running',
    createdAt: Date.now(),
  };
  const existing = parseRecord(
    await evalScript(
      getRedis(),
      CLAIM_IDEMPOTENCY_KEY,
      1,
      recordKey(username, route, key),
      JSON.stringify(record),
      IDEMPOTENCY_RETENTION_SECONDS,
    ),
  );
  if (!existing) return { kind: 'claimed' };
  return existing.requestHash === requestHash
    ? { kind: 'existing', record: existing }
    : { kind: 'mismatch', record: existing };
}

/** Record a run's final outcome for replay; only the binding job may. */
export async function settleIdempotencyKey(
  username: string,
  route: string,
  key: string,
  jobId: string,
  state: 'completed' | 'failed' | 'uncertain',
  outcome?: StoredOutcome,
): Promise<void> {
  await evalScript(
    getRedis(),
    SETTLE_IDEMPOTENCY_KEY,
    1,
    recordKey(username, route, key),
    jobId,
    state,
    outcome ? JSON.stringify(outcome) : '',
  );
}

/** Forget a binding whose submission was rejected before anything ran. */
export async function releaseIdempotencyKey(
  username: string,
  route: string,
  key: string,
  jobId: string,
): Promise<void> {
  await evalScript(
    getRedis(),
    RELEASE_IDEMPOTENCY_KEY,
    1,
    recordKey(username, route, key),
    jobId,
  );
}
