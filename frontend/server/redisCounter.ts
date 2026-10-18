import { getRedis } from './session/redis';

const INCREMENT_COUNTER = `
-- INCREMENT_EXPIRING_COUNTER
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

// Check every limit and reserve one attempt in every counter in one script.
// A separate read and later increment let concurrent requests all pass the
// check before any of them was counted. Counters without an expiry (legacy
// interrupted initialization) are repaired here.
const RESERVE_ATTEMPT = `
-- RESERVE_LIMITED_ATTEMPT
local retry_after = 0
for index, key in ipairs(KEYS) do
  local count = tonumber(redis.call('GET', key) or '0')
  if count >= tonumber(ARGV[index + 2]) then
    local ttl = redis.call('TTL', key)
    if ttl == -1 then
      redis.call('EXPIRE', key, ARGV[2])
      ttl = tonumber(ARGV[2])
    elseif ttl <= 0 then
      ttl = tonumber(ARGV[2])
    end
    if ttl > retry_after then retry_after = ttl end
  end
end
if retry_after > 0 then return retry_after end
for _, key in ipairs(KEYS) do
  redis.call('INCR', key)
  if redis.call('TTL', key) < 0 then
    redis.call('EXPIRE', key, ARGV[1])
  end
end
return 0
`;

const CONFIRM_FAILED_ATTEMPT = `
-- CONFIRM_FAILED_ATTEMPT
for index, key in ipairs(KEYS) do
  if tonumber(redis.call('GET', key) or '0') >= tonumber(ARGV[index + 1]) then
    redis.call('EXPIRE', key, ARGV[1])
  end
end
return 1
`;

// Return a reservation without creating a key or changing a window's expiry.
const RELEASE_ATTEMPT = `
-- RELEASE_LIMITED_ATTEMPT
for _, key in ipairs(KEYS) do
  if tonumber(redis.call('GET', key) or '0') > 0 then
    redis.call('DECR', key)
  end
end
return 1
`;

export interface AttemptCounter {
  key: string;
  limit: number;
}

export async function incrementExpiringCounter(
  key: string,
  windowSeconds: number,
): Promise<[number, number]> {
  return (await getRedis().eval(INCREMENT_COUNTER, 1, key, windowSeconds)) as [
    number,
    number,
  ];
}

/**
 * Reserve one attempt against every counter, or return the seconds until the
 * longest exhausted counter expires. A reservation counts as an attempt until
 * it is released.
 */
export async function reserveLimitedAttempt(
  counters: AttemptCounter[],
  windowSeconds: number,
  lockSeconds: number,
): Promise<number> {
  return Number(
    await getRedis().eval(
      RESERVE_ATTEMPT,
      counters.length,
      ...counters.map(({ key }) => key),
      windowSeconds,
      lockSeconds,
      ...counters.map(({ limit }) => limit),
    ),
  );
}

/** Keep a reserved attempt as a failure; exhausted counters start lockout. */
export async function confirmFailedAttempt(
  counters: AttemptCounter[],
  lockSeconds: number,
): Promise<void> {
  await getRedis().eval(
    CONFIRM_FAILED_ATTEMPT,
    counters.length,
    ...counters.map(({ key }) => key),
    lockSeconds,
    ...counters.map(({ limit }) => limit),
  );
}

export async function releaseLimitedAttempt(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await getRedis().eval(RELEASE_ATTEMPT, keys.length, ...keys);
}
