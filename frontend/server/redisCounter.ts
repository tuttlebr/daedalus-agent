import { getRedis } from './session/redis';

const INCREMENT_COUNTER = `
-- INCREMENT_EXPIRING_COUNTER
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
if tonumber(ARGV[2]) > 0 and count >= tonumber(ARGV[2]) then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  ttl = tonumber(ARGV[3])
end
return {count, ttl}
`;
const READ_COUNTER = `
-- READ_EXPIRING_COUNTER: repair legacy interrupted initialization too.
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local ttl = redis.call('TTL', KEYS[1])
if ttl == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export async function incrementExpiringCounter(
  key: string,
  windowSeconds: number,
  lockAfter = 0,
  lockSeconds = windowSeconds,
): Promise<[number, number]> {
  return (await getRedis().eval(
    INCREMENT_COUNTER,
    1,
    key,
    windowSeconds,
    lockAfter,
    lockSeconds,
  )) as [number, number];
}

export async function readExpiringCounter(
  key: string,
  repairSeconds: number,
): Promise<[number, number]> {
  return (await getRedis().eval(READ_COUNTER, 1, key, repairSeconds)) as [
    number,
    number,
  ];
}
