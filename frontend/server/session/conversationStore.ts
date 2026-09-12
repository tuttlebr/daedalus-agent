import { getRedis, sessionKey } from './redis';

const EXPIRY_SECONDS = 60 * 60 * 24 * 7;
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
const SAVE = `${READ}
-- SAVE_OWNED_CONVERSATION: authorize and compare the same snapshot we replace.
local raw = read(KEYS[1])
if raw ~= ARGV[1] then return 0 end
if raw ~= '' then
  local current = cjson.decode(raw)
  if redis.call('SISMEMBER', KEYS[2], ARGV[3]) ~= 1
    or (current['ownerId'] and current['ownerId'] ~= ARGV[4]) then return -1 end
elseif ARGV[6] ~= '1' then
  return -1
end
if redis.call('TYPE', KEYS[1]).ok == 'string' or raw == '' then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[5])
else
  redis.call('JSON.SET', KEYS[1], '$', ARGV[2])
  redis.call('EXPIRE', KEYS[1], ARGV[5])
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
): Promise<Record<string, any>> {
  const client = getRedis();
  const keys = [
    sessionKey(['conversation', id]),
    sessionKey(['user', username, 'conversations']),
  ];
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
    const value = { ...update(current), id, ownerId: username };
    const result = await client.eval(
      SAVE,
      2,
      ...keys,
      raw,
      JSON.stringify(value),
      id,
      username,
      EXPIRY_SECONDS,
      allowCreate ? '1' : '0',
    );
    if (result === 1) return value;
    if (result === -1) throw new ConversationWriteError('forbidden');
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
  } while (Date.now() < deadline);
  throw new Error('Conversation changed repeatedly during save');
}

export async function reserveConversationForUser(
  username: string,
  id: string,
  name?: string,
) {
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
  );
}
