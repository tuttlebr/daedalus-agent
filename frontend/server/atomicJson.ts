import { getRedis } from '@/server/session/redis';

const READ = `
local reply = redis.call('TYPE', KEYS[1])
local kind = type(reply) == 'table' and reply['ok'] or reply
local raw = ''
if kind == 'string' then raw = redis.call('GET', KEYS[1])
elseif string.find(string.lower(kind), 'rejson', 1, true) then raw = redis.call('JSON.GET', KEYS[1], '.')
elseif kind ~= 'none' then return redis.error_reply('unsupported JSON key type: ' .. kind) end
`;
const SNAPSHOT = `${READ}\nreturn {kind, raw}`;
const REPLACE = `${READ}
if kind ~= ARGV[1] or raw ~= ARGV[2] then return 0 end
if string.find(string.lower(kind), 'rejson', 1, true) then
  redis.call('JSON.SET', KEYS[1], '$', ARGV[3])
else
  redis.call('SET', KEYS[1], ARGV[3], 'KEEPTTL')
end
if tonumber(ARGV[4]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[4]) end
return 1
`;

/** Retry the operation against a fresh exact snapshot, never a stale list.
 * Keep JSON opaque in Lua to preserve arrays and exact JS integers. Compatible
 * with Python WATCH/MULTI and existing RedisJSON/plain-string records.
 */
export async function updateJsonAtomically<T>(
  key: string,
  update: (current: T | null) => T | null | Promise<T | null>,
  ttlSeconds = 0,
): Promise<T | null> {
  const redis = getRedis();
  const deadline = performance.now() + 5000;
  do {
    const [kind, raw] = (await redis.eval(SNAPSHOT, 1, key)) as [
      string,
      string,
    ];
    const current = kind === 'none' ? null : (JSON.parse(raw) as T);
    const next = await update(current);
    if (next === null) return null;
    if (
      (await redis.eval(
        REPLACE,
        1,
        key,
        kind,
        raw,
        JSON.stringify(next),
        ttlSeconds,
      )) === 1
    )
      return next;
    await new Promise((resolve) =>
      setTimeout(resolve, 5 + Math.floor(Math.random() * 20)),
    );
  } while (performance.now() < deadline);
  throw new Error('Concurrent update could not be committed. Please retry.');
}
