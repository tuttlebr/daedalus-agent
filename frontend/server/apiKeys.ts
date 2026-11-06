import { getAuthConfig } from '@/utils/auth/config';

import { getRedis, sessionKey } from '@/server/session/redis';
import { evalScript, redisScript } from '@/server/session/redisScript';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * User-bound API keys for the OpenAI/Anthropic compatible endpoints.
 *
 * A key is `dkey_<id>_<secret>`. Only a SHA-256 verifier of the 256-bit
 * secret is stored; the secret is returned once, at creation or rotation.
 * A fast digest is sufficient because the secret is uniformly random, not a
 * password. Each key resolves to a configured Daedalus account; removing the
 * account disables its keys without deleting their records.
 */

export const MAX_API_KEYS_PER_USER = 10;
export const MAX_API_KEY_NAME_LENGTH = 64;
// Avoid a Redis write per request; listings show the time to this precision.
const LAST_USED_REFRESH_MS = 60_000;
const LAST_USED_TTL_SECONDS = 400 * 24 * 60 * 60;

const KEY_PATTERN = /^dkey_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/;

export interface ApiKeyMetadata {
  id: string;
  name: string;
  /** Recognizable, non-secret prefix shown in listings. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface StoredApiKey {
  id: string;
  username: string;
  name: string;
  verifier: string;
  createdAt: number;
}

export interface ApiKeyPrincipal {
  username: string;
  userId: string;
  name: string;
  keyId: string;
}

export class ApiKeyError extends Error {
  constructor(
    public readonly reason:
      | 'invalid_name'
      | 'limit_reached'
      | 'not_found'
      | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'ApiKeyError';
  }
}

const recordKey = (id: string) => sessionKey(['api-key', id]);
const lastUsedKey = (id: string) => sessionKey(['api-key-last-used', id]);
const userKeysKey = (username: string) =>
  sessionKey(['user', username, 'api-keys']);

function verifierFor(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function prefixFor(id: string): string {
  return `dkey_${id.slice(0, 8)}`;
}

function mintKey(): { id: string; secret: string; key: string } {
  const id = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { id, secret, key: `dkey_${id}_${secret}` };
}

export function normalizeApiKeyName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (
    !name ||
    name.length > MAX_API_KEY_NAME_LENGTH ||
    // Control characters would corrupt listings and logs.
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new ApiKeyError(
      'invalid_name',
      `Key names must be 1-${MAX_API_KEY_NAME_LENGTH} printable characters.`,
    );
  }
  return name;
}

// KEYS: record, user set. ARGV: id, record JSON, limit.
const CREATE_API_KEY = redisScript(`
-- CREATE_API_KEY
if redis.call('SCARD', KEYS[2]) >= tonumber(ARGV[3]) then return -1 end
if not redis.call('SET', KEYS[1], ARGV[2], 'NX') then return 0 end
redis.call('SADD', KEYS[2], ARGV[1])
return 1
`);

// KEYS: record, last-used, user set. ARGV: id, owner.
const REVOKE_API_KEY = redisScript(`
-- REVOKE_API_KEY
local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('SREM', KEYS[3], ARGV[1])
  return 0
end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' or record['username'] ~= ARGV[2] then
  return 0
end
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('SREM', KEYS[3], ARGV[1])
return 1
`);

// KEYS: old record, old last-used, user set, new record.
// ARGV: old id, owner, new id, new record JSON.
const ROTATE_API_KEY = redisScript(`
-- ROTATE_API_KEY
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' or record['username'] ~= ARGV[2] then
  return 0
end
if not redis.call('SET', KEYS[4], ARGV[4], 'NX') then return -1 end
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('SREM', KEYS[3], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[3])
return 1
`);

function parseStored(raw: string | null): StoredApiKey | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as StoredApiKey;
    return value &&
      typeof value.id === 'string' &&
      typeof value.username === 'string' &&
      typeof value.verifier === 'string' &&
      typeof value.name === 'string' &&
      typeof value.createdAt === 'number'
      ? value
      : null;
  } catch {
    return null;
  }
}

function metadataFor(
  record: StoredApiKey,
  lastUsed: string | null,
): ApiKeyMetadata {
  const lastUsedAt = Number(lastUsed);
  return {
    id: record.id,
    name: record.name,
    prefix: prefixFor(record.id),
    createdAt: record.createdAt,
    lastUsedAt:
      Number.isFinite(lastUsedAt) && lastUsedAt > 0 ? lastUsedAt : null,
  };
}

export async function listApiKeys(username: string): Promise<ApiKeyMetadata[]> {
  const client = getRedis();
  const ids = (await client.smembers(userKeysKey(username))).filter((id) =>
    KEY_ID_PATTERN.test(id),
  );
  if (!ids.length) return [];
  const values = await client.mget(
    ...ids.flatMap((id) => [recordKey(id), lastUsedKey(id)]),
  );
  const keys: ApiKeyMetadata[] = [];
  ids.forEach((id, index) => {
    const record = parseStored(values[index * 2]);
    if (record?.username === username && record.id === id) {
      keys.push(metadataFor(record, values[index * 2 + 1]));
    }
  });
  return keys.sort((a, b) => b.createdAt - a.createdAt);
}

export async function createApiKey(
  username: string,
  name: unknown,
): Promise<{ key: string; metadata: ApiKeyMetadata }> {
  const normalizedName = normalizeApiKeyName(name);
  const minted = mintKey();
  const record: StoredApiKey = {
    id: minted.id,
    username,
    name: normalizedName,
    verifier: verifierFor(minted.secret),
    createdAt: Date.now(),
  };
  const result = await evalScript(
    getRedis(),
    CREATE_API_KEY,
    2,
    recordKey(minted.id),
    userKeysKey(username),
    minted.id,
    JSON.stringify(record),
    MAX_API_KEYS_PER_USER,
  );
  if (result === -1) {
    throw new ApiKeyError(
      'limit_reached',
      `You can have at most ${MAX_API_KEYS_PER_USER} API keys. Revoke one before creating another.`,
    );
  }
  if (result !== 1) {
    // A 64-bit random ID collision; the caller can simply retry.
    throw new ApiKeyError('conflict', 'Could not create a key. Try again.');
  }
  return { key: minted.key, metadata: metadataFor(record, null) };
}

export async function revokeApiKey(
  username: string,
  keyId: string,
): Promise<void> {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new ApiKeyError('not_found', 'API key not found.');
  }
  const result = await evalScript(
    getRedis(),
    REVOKE_API_KEY,
    3,
    recordKey(keyId),
    lastUsedKey(keyId),
    userKeysKey(username),
    keyId,
    username,
  );
  if (result !== 1) throw new ApiKeyError('not_found', 'API key not found.');
}

/**
 * Replace a key with a new secret under the same name in one commit; the old
 * secret stops working at the same moment the new one starts.
 */
export async function rotateApiKey(
  username: string,
  keyId: string,
): Promise<{ key: string; metadata: ApiKeyMetadata }> {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new ApiKeyError('not_found', 'API key not found.');
  }
  const current = parseStored(await getRedis().get(recordKey(keyId)));
  if (!current || current.username !== username) {
    throw new ApiKeyError('not_found', 'API key not found.');
  }
  const minted = mintKey();
  const record: StoredApiKey = {
    id: minted.id,
    username,
    name: current.name,
    verifier: verifierFor(minted.secret),
    createdAt: Date.now(),
  };
  const result = await evalScript(
    getRedis(),
    ROTATE_API_KEY,
    4,
    recordKey(keyId),
    lastUsedKey(keyId),
    userKeysKey(username),
    recordKey(minted.id),
    keyId,
    username,
    minted.id,
    JSON.stringify(record),
  );
  if (result === 0) throw new ApiKeyError('not_found', 'API key not found.');
  if (result !== 1) {
    throw new ApiKeyError('conflict', 'Could not rotate the key. Try again.');
  }
  return { key: minted.key, metadata: metadataFor(record, null) };
}

/**
 * Resolve a presented key to its account. Returns null for any malformed,
 * unknown, revoked or mismatched key, and for keys whose account is no longer
 * configured, without distinguishing those cases to the caller.
 */
export async function verifyApiKey(
  presented: string,
): Promise<ApiKeyPrincipal | null> {
  const match = KEY_PATTERN.exec(presented);
  if (!match) return null;
  const [, id, secret] = match;
  const client = getRedis();
  const [raw, lastUsed] = await client.mget(recordKey(id), lastUsedKey(id));
  const record = parseStored(raw);
  if (!record || record.id !== id) return null;
  const expected = Buffer.from(record.verifier, 'hex');
  const actual = Buffer.from(verifierFor(secret), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  const user = getAuthConfig().users.find(
    (candidate) => candidate.username === record.username,
  );
  if (!user) return null;

  const now = Date.now();
  if (!(Number(lastUsed) > now - LAST_USED_REFRESH_MS)) {
    // Best effort: usage tracking must never reject an authenticated call.
    await client
      .set(lastUsedKey(id), String(now), 'EX', LAST_USED_TTL_SECONDS)
      .catch(() => undefined);
  }
  return {
    username: user.username,
    userId: user.id,
    name: user.name,
    keyId: id,
  };
}
