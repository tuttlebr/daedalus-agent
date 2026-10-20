import { getRedis, sessionKey } from './redis';

import { abortKey } from '@/server/chat/jobState';

const READ = `
local function read(key)
  local kind = redis.call('TYPE', key).ok
  if kind == 'none' then return '' end
  if kind == 'string' then return redis.call('GET', key) end
  return redis.call('JSON.GET', key, '.')
end
`;
const SNAPSHOT = `${READ}
-- READ_OWNED_CONVERSATION
return {read(KEYS[1]), redis.call('SISMEMBER', KEYS[2], ARGV[1])}
`;
const RESERVATION = `${READ}
-- READ_CONVERSATION_RESERVATION
return {read(KEYS[1]), redis.call('SISMEMBER', KEYS[2], ARGV[1]), redis.call('TTL', KEYS[1])}
`;
const SAVE = `${READ}
-- SAVE_OWNED_CONVERSATION: authorize and compare the same snapshot we replace.
-- A delayed finalizer must not overwrite a later turn after its lock expired.
local fence_index = tonumber(ARGV[7])
if fence_index > 0 and redis.call('GET', KEYS[fence_index]) ~= ARGV[8] then return -3 end
-- A chat reservation must not recreate a conversation deleted while its
-- submission was initializing. Check the job's stop signal in this commit.
local cancellation_index = tonumber(ARGV[6])
if cancellation_index > 0 and redis.call('EXISTS', KEYS[cancellation_index]) == 1 then return -2 end
local raw = read(KEYS[1])
if raw ~= ARGV[1] then return 0 end
if raw ~= '' then
  local current = cjson.decode(raw)
  if redis.call('SISMEMBER', KEYS[2], ARGV[3]) ~= 1
    or (current['ownerId'] and current['ownerId'] ~= ARGV[4]) then return -1 end
elseif ARGV[5] ~= '1' then
  return -1
end
if redis.call('TYPE', KEYS[1]).ok == 'string' or raw == '' then
  redis.call('SET', KEYS[1], ARGV[2])
else
  redis.call('JSON.SET', KEYS[1], '$', ARGV[2])
  redis.call('PERSIST', KEYS[1])
end
redis.call('SADD', KEYS[2], ARGV[3])
return 1
`;

export class ConversationWriteError extends Error {
  constructor(
    public readonly reason: 'forbidden' | 'conflict',
    public readonly serverState?: Record<string, any>,
  ) {
    super(
      reason === 'forbidden'
        ? 'Forbidden: You do not have access to this conversation'
        : 'Conflict: server has newer data',
    );
  }
}

export class ConversationWriteFenceError extends Error {
  constructor() {
    super('Conversation write ownership expired');
  }
}

export async function readConversationForUser(
  username: string,
  id: string,
): Promise<Record<string, any> | null> {
  const [raw, member] = (await getRedis().eval(
    SNAPSHOT,
    2,
    sessionKey(['conversation', id]),
    sessionKey(['user', username, 'conversations']),
    id,
  )) as [string, number];
  const current = raw ? JSON.parse(raw) : null;
  if (member !== 1 || (current?.ownerId && current.ownerId !== username))
    throw new ConversationWriteError('forbidden');
  return current;
}

/**
 * Set membership authorizes legacy records; new records also bind their owner.
 * The binding prevents stale membership surviving TTL/deletion from granting
 * access when another user later creates the same ID. Client copies never grant
 * membership. Values remain opaque in Lua to preserve arrays and exact numbers.
 */
export async function saveConversationForUser(
  username: string,
  id: string,
  update: (current: Record<string, any> | null) => Record<string, any>,
  allowCreate = false,
  pendingJobId?: string,
  writeFence?: { key: string; token: string },
): Promise<Record<string, any>> {
  const client = getRedis();
  const keys = [
    sessionKey(['conversation', id]),
    sessionKey(['user', username, 'conversations']),
  ];
  const cancellationKeys = pendingJobId ? [abortKey(pendingJobId)] : [];
  const fenceKeys = writeFence ? [writeFence.key] : [];
  const deadline = Date.now() + 5000;
  do {
    const [raw, member] = (await client.eval(SNAPSHOT, 2, ...keys, id)) as [
      string,
      number,
    ];
    const current = raw ? JSON.parse(raw) : null;
    if (
      current
        ? member !== 1 || (current.ownerId && current.ownerId !== username)
        : !allowCreate
    ) {
      throw new ConversationWriteError('forbidden');
    }
    // Identity leads the record so ownership checks read only its first bytes
    // (readConversationOwner in server/session/redisShared.ts).
    const {
      id: _id,
      ownerId: _ownerId,
      ...fields
    } = update(current) as Record<string, any>;
    const value = { id, ownerId: username, ...fields };
    const result = await client.eval(
      SAVE,
      keys.length + cancellationKeys.length + fenceKeys.length,
      ...keys,
      ...cancellationKeys,
      ...fenceKeys,
      raw,
      JSON.stringify(value),
      id,
      username,
      allowCreate ? '1' : '0',
      pendingJobId ? keys.length + 1 : 0,
      writeFence ? keys.length + cancellationKeys.length + 1 : 0,
      writeFence?.token ?? '',
    );
    if (result === 1) return value;
    if (result === -1) throw new ConversationWriteError('forbidden');
    if (result === -2) throw new ConversationWriteError('conflict');
    if (result === -3) throw new ConversationWriteFenceError();
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
  } while (Date.now() < deadline);
  throw new Error('Conversation changed repeatedly during save');
}

export async function reserveConversationForUser(
  username: string,
  id: string,
  name?: string,
  pendingJobId?: string,
) {
  // Every chat turn reserves its conversation. A durable record already bound
  // to this user needs no write: rewriting it unchanged sent the whole history
  // through Redis twice before the job could be queued. The atomic snapshot
  // authorizes it exactly as the save script would.
  const [raw, member, ttl] = (await getRedis().eval(
    RESERVATION,
    2,
    sessionKey(['conversation', id]),
    sessionKey(['user', username, 'conversations']),
    id,
  )) as [string, number, number];
  if (raw && member === 1 && ttl === -1) {
    const current = JSON.parse(raw);
    if (current?.ownerId === username && current.id === id) return current;
  }
  // New, legacy (unbound or expiring) and foreign records keep the
  // compare-and-set path that creates, binds or rejects them.
  return saveConversationForUser(
    username,
    id,
    (current) =>
      current ?? {
        id,
        name: typeof name === 'string' ? name : 'New conversation',
        messages: [],
        folderId: null,
        updatedAt: 0,
      },
    true,
    pendingJobId,
  );
}
