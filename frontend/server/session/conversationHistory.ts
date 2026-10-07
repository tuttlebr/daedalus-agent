import { dedupeConversationsById } from '@/utils/app/conversationList';
import { sanitizeConversationsAssistantReplays } from '@/utils/app/conversationReplay';

import type { Conversation } from '@/types/chat';

import { getRedis, sessionKey } from './redis';
import { stripBase64FromObject } from './sanitize';

const READ_JSON = `
local function read(key)
  local kind = redis.call('TYPE', key).ok
  if kind == 'none' then return '' end
  if kind == 'string' then return redis.call('GET', key) end
  return redis.call('JSON.GET', key, '.')
end
`;

const READ_HISTORY = `${READ_JSON}
return read(KEYS[1])
`;

const LIST_HISTORY = `${READ_JSON}
-- Read membership, records and legacy history in one snapshot. A history copy
-- never grants access to the shared record; membership AND owner must match.
local history = read(KEYS[1])
local records = {}
for _, id in ipairs(redis.call('SMEMBERS', KEYS[2])) do
  local key = ARGV[2] .. id
  local raw = read(key)
  if raw ~= '' then
    local owner = cjson.decode(raw)['ownerId']
    if not owner or owner == ARGV[1] then
      table.insert(records, {id, raw})
      redis.call('PERSIST', key)
    end
  end
end
redis.call('PERSIST', KEYS[1])
return {history, records}
`;

const MERGE_HISTORY = `${READ_JSON}
-- Compare the exact opaque document so concurrent saves/deletes cannot lose
-- other entries. Keep JSON serialization in JS to preserve arrays and numbers.
if read(KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('TYPE', KEYS[1]).ok == 'string' or ARGV[1] == '' then
  redis.call('SET', KEYS[1], ARGV[2])
else
  redis.call('JSON.SET', KEYS[1], '$', ARGV[2])
  redis.call('PERSIST', KEYS[1])
end
return 1
`;

function parseHistory(raw: string): Conversation[] {
  const history = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(history)) throw new Error('Invalid conversation history');
  return history;
}

/**
 * Saved chats are durable until explicit deletion. The legacy history document
 * is only one source: worker completions and older saves also live in owned
 * conversation records. Reconcile both without writing a stale snapshot back.
 * PERSIST migrates surviving seven-day records without changing their contents.
 */
export async function listConversationHistoryForUser(
  username: string,
): Promise<Conversation[]> {
  const [raw, records] = (await getRedis().eval(
    LIST_HISTORY,
    2,
    sessionKey(['user', username, 'conversationHistory']),
    sessionKey(['user', username, 'conversations']),
    username,
    `${sessionKey(['conversation'])}:`,
  )) as [string, [string, string][]];
  const conversations = [
    ...parseHistory(raw),
    ...records.map(([id, value]) => ({ ...JSON.parse(value), id })),
  ];
  return sanitizeConversationsAssistantReplays(
    dedupeConversationsById(conversations),
  );
}

/** Merge legacy/imported history without truncation, expiry or lost updates. */
export async function mergeConversationHistoryForUser(
  username: string,
  incoming: Conversation[],
): Promise<void> {
  const client = getRedis();
  const key = sessionKey(['user', username, 'conversationHistory']);
  const clean = stripBase64FromObject(incoming);
  const deadline = Date.now() + 5_000;
  do {
    const raw = (await client.eval(READ_HISTORY, 1, key)) as string;
    const merged = sanitizeConversationsAssistantReplays(
      dedupeConversationsById([...parseHistory(raw), ...clean]),
    );
    if (
      (await client.eval(
        MERGE_HISTORY,
        1,
        key,
        raw,
        JSON.stringify(merged),
      )) === 1
    ) {
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, 10 + Math.random() * 40),
    );
  } while (Date.now() < deadline);
  throw new Error('Conversation history changed repeatedly during save');
}
