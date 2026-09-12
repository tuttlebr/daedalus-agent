import { getRedis, sessionKey } from './redis';

// Keep JSON opaque in Lua so unrelated messages retain empty arrays and exact
// integers. Read failures must abort deletion, never masquerade as empty history.
const READ_JSON_SNAPSHOT_LUA = `
local function read_json(key)
  local kind = redis.call('TYPE', key).ok
  if kind == 'none' then return '' end
  if kind == 'string' then return redis.call('GET', key) end
  return redis.call('JSON.GET', key, '.')
end
`;

const READ_DELETION_SNAPSHOT_LUA = `
-- READ_CONVERSATION_DELETION_SNAPSHOT
${READ_JSON_SNAPSHOT_LUA}
local owned = redis.call('SISMEMBER', KEYS[1], ARGV[1])
local conversation = read_json(KEYS[4])
if conversation ~= '' then
  local owner = cjson.decode(conversation)['ownerId']
  if owner and owner ~= ARGV[2] then owned = 0 end
end
return {
  owned,
  read_json(KEYS[2]),
  read_json(KEYS[3]),
  conversation
}
`;

const APPLY_DELETION_LUA = `
-- APPLY_CONVERSATION_DELETION
${READ_JSON_SNAPSHOT_LUA}
local owned = redis.call('SISMEMBER', KEYS[1], ARGV[1])
local conversation = read_json(KEYS[4])
if conversation ~= ARGV[7] then return 0 end
if conversation ~= '' then
  local owner = cjson.decode(conversation)['ownerId']
  if owner and owner ~= ARGV[8] then owned = 0 end
end
if owned ~= tonumber(ARGV[2]) or read_json(KEYS[2]) ~= ARGV[3]
  or read_json(KEYS[3]) ~= ARGV[4] then
  return 0
end

if ARGV[5] ~= '' then
  if redis.call('TYPE', KEYS[2]).ok == 'string' then
    redis.call('SET', KEYS[2], ARGV[5], 'KEEPTTL')
  else
    redis.call('JSON.SET', KEYS[2], '$', ARGV[5])
  end
end
if ARGV[6] == '1' then redis.call('DEL', KEYS[3]) end
if ARGV[2] == '1' then
  redis.call('DEL', KEYS[4])
  redis.call('SREM', KEYS[1], ARGV[1])
end
return 1
`;

/**
 * Remove a user's saved copies, including history-only/expired conversations.
 * History and selection accept client-supplied IDs, so they never authorize
 * deletion of the shared conversation key; only set membership does that.
 */
export async function deleteConversationForUser(
  username: string,
  id: string,
): Promise<boolean> {
  const client = getRedis();
  const keys = [
    sessionKey(['user', username, 'conversations']),
    sessionKey(['user', username, 'conversationHistory']),
    sessionKey(['user', username, 'selectedConversation']),
    sessionKey(['conversation', id]),
  ];

  const retryDeadline = Date.now() + 5_000;
  do {
    const [owned, historyRaw, selectedRaw, conversationRaw] =
      (await client.eval(
        READ_DELETION_SNAPSHOT_LUA,
        keys.length,
        ...keys,
        id,
        username,
      )) as [number, string, string, string];
    const history = historyRaw ? JSON.parse(historyRaw) : [];
    if (!Array.isArray(history)) {
      throw new Error('Invalid conversation history');
    }
    const selected = selectedRaw ? JSON.parse(selectedRaw) : null;
    const remaining = history.filter((conversation) => conversation?.id !== id);
    const removeFromHistory = remaining.length !== history.length;
    const removeSelected = selected?.id === id;
    if (!owned && !removeFromHistory && !removeSelected) return false;

    const applied = await client.eval(
      APPLY_DELETION_LUA,
      keys.length,
      ...keys,
      id,
      owned,
      historyRaw,
      selectedRaw,
      removeFromHistory ? JSON.stringify(remaining) : '',
      removeSelected ? '1' : '0',
      conversationRaw,
      username,
    );
    if (applied === 1) return true;
    // A concurrent save/delete changed the snapshot. Recompute the removal
    // from current data so another conversation or selection is not lost.
    // Clear-all issues parallel requests: jitter prevents them from repeatedly
    // racing in lockstep and exhausting a small fixed retry count.
    await new Promise((resolve) =>
      setTimeout(resolve, 10 + Math.random() * 40),
    );
  } while (Date.now() < retryDeadline);
  throw new Error('Conversation changed repeatedly during deletion');
}
