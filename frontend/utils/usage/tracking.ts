import { Logger } from '@/utils/logger';

import { getRedis, sessionKey, jsonGet, jsonSet } from '@/server/session/redis';

const logger = new Logger('UsageTracking');

/**
 * Usage data structure matching the OpenAPI Usage schema
 */
export interface UsageData {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * User usage statistics stored in Redis
 */
export interface UserUsageStats {
  username: string;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  request_count: number;
  first_request_at: number;
  last_request_at: number;
  daily_usage: Record<string, UsageData>; // Date string (YYYY-MM-DD) -> usage
  monthly_usage: Record<string, UsageData>; // Month string (YYYY-MM) -> usage
}

/**
 * Get the Redis key for user usage stats
 */
function getUserUsageKey(username: string): string {
  return sessionKey(['usage', 'user', username]);
}

const USAGE_LOCK_TTL_MS = 5_000;

/**
 * Serialize the read-modify-write on a user's usage doc with a short-lived
 * Redis lock so concurrent /api/usage/track calls (multi-device sync is a core
 * feature) don't clobber each other's increments (F-004). Works in both
 * RedisJSON and plain-Redis modes (unlike JSON.NUMINCRBY). Falls back to an
 * unlocked write if the lock can't be acquired, preserving availability.
 */
async function withUsageLock<T>(
  username: string,
  fn: () => Promise<T>,
): Promise<T> {
  const redis = getRedis();
  const lockKey = sessionKey(['usage', 'lock', username]);
  const token = `${Date.now()}-${Math.random()}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    const acquired = await redis.set(
      lockKey,
      token,
      'PX',
      USAGE_LOCK_TTL_MS,
      'NX',
    );
    if (acquired === 'OK') {
      try {
        return await fn();
      } finally {
        try {
          await redis.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            lockKey,
            token,
          );
        } catch {
          // best-effort unlock; the PX TTL prevents a permanent deadlock
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Lock contention exceeded the budget — proceed unlocked rather than dropping
  // the update (matches the prior last-writer-wins behavior).
  return fn();
}

/**
 * Get the current date string (YYYY-MM-DD)
 */
function getCurrentDateString(): string {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

/**
 * Get the current month string (YYYY-MM)
 */
function getCurrentMonthString(): string {
  const now = new Date();
  return now.toISOString().substring(0, 7);
}

/**
 * Initialize user usage stats if they don't exist
 */
async function initializeUserUsageStats(
  username: string,
): Promise<UserUsageStats> {
  const stats: UserUsageStats = {
    username,
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    total_tokens: 0,
    request_count: 0,
    first_request_at: Date.now(),
    last_request_at: Date.now(),
    daily_usage: {},
    monthly_usage: {},
  };

  const key = getUserUsageKey(username);
  await jsonSet(key, '.', stats);
  return stats;
}

/**
 * Track usage for a user
 * @param username - The username to track usage for
 * @param usage - Usage data from the API response
 */
export async function trackUserUsage(
  username: string,
  usage: UsageData,
): Promise<void> {
  const key = getUserUsageKey(username);

  logger.debug('trackUserUsage called', {
    username,
    key,
    usage,
  });

  try {
    await withUsageLock(username, async () => {
      // Get existing stats or initialize new ones
      let stats = (await jsonGet(key)) as UserUsageStats | null;
      if (!stats) {
        logger.info('initializing new user stats for', username);
        stats = await initializeUserUsageStats(username);
      }

      const dateString = getCurrentDateString();
      const monthString = getCurrentMonthString();

      // Update total usage
      stats.total_prompt_tokens += usage.prompt_tokens;
      stats.total_completion_tokens += usage.completion_tokens;
      stats.total_tokens += usage.total_tokens;
      stats.request_count += 1;
      stats.last_request_at = Date.now();

      // Update daily usage
      if (!stats.daily_usage[dateString]) {
        stats.daily_usage[dateString] = {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        };
      }
      stats.daily_usage[dateString].prompt_tokens += usage.prompt_tokens;
      stats.daily_usage[dateString].completion_tokens +=
        usage.completion_tokens;
      stats.daily_usage[dateString].total_tokens += usage.total_tokens;

      // Update monthly usage
      if (!stats.monthly_usage[monthString]) {
        stats.monthly_usage[monthString] = {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        };
      }
      stats.monthly_usage[monthString].prompt_tokens += usage.prompt_tokens;
      stats.monthly_usage[monthString].completion_tokens +=
        usage.completion_tokens;
      stats.monthly_usage[monthString].total_tokens += usage.total_tokens;

      // Save updated stats
      await jsonSet(key, '.', stats);
    });

    logger.info(
      `usage tracked successfully for user ${username}: ${usage.total_tokens} total tokens (${usage.prompt_tokens} prompt + ${usage.completion_tokens} completion)`,
    );
  } catch (error) {
    logger.error('error in trackUserUsage', error);
    throw error;
  }
}

/**
 * Get usage statistics for a user
 * @param username - The username to get stats for
 * @returns User usage statistics or null if not found
 */
export async function getUserUsageStats(
  username: string,
): Promise<UserUsageStats | null> {
  const key = getUserUsageKey(username);

  try {
    const stats = (await jsonGet(key)) as UserUsageStats | null;
    return stats;
  } catch (error) {
    logger.error('Error getting user usage stats', error);
    return null;
  }
}

/**
 * Get usage statistics for all users
 * @returns Array of user usage statistics
 */
export async function getAllUsageStats(): Promise<UserUsageStats[]> {
  const redis = getRedis();
  const pattern = sessionKey(['usage', 'user', '*']);

  try {
    // SCAN instead of KEYS — KEYS is O(N) and blocks the Redis event loop on
    // large keyspaces (F-018).
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');

    const stats: UserUsageStats[] = [];

    if (keys.length > 0) {
      for (const key of keys) {
        const userStats = (await jsonGet(key)) as UserUsageStats | null;
        if (userStats) {
          stats.push(userStats);
        }
      }
    }

    return stats;
  } catch (error) {
    logger.error('Error getting all usage stats', error);
    return [];
  }
}

/**
 * Reset usage statistics for a user
 * @param username - The username to reset stats for
 */
export async function resetUserUsageStats(username: string): Promise<void> {
  try {
    await initializeUserUsageStats(username);
    logger.info(`Usage stats reset for user ${username}`);
  } catch (error) {
    logger.error('Error resetting user usage stats', error);
    throw error;
  }
}

/**
 * Clean up old daily usage data (keep last 90 days)
 * @param username - The username to clean up data for
 */
export async function cleanupOldUsageData(username: string): Promise<void> {
  const key = getUserUsageKey(username);

  try {
    await withUsageLock(username, async () => {
      const stats = (await jsonGet(key)) as UserUsageStats | null;
      if (!stats) return;

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 90);
      const cutoffString = cutoffDate.toISOString().split('T')[0];

      // Remove old daily usage entries
      for (const dateString in stats.daily_usage) {
        if (dateString < cutoffString) {
          delete stats.daily_usage[dateString];
        }
      }

      // Save updated stats
      await jsonSet(key, '.', stats);
      logger.info(`Cleaned up old usage data for user ${username}`);
    });
  } catch (error) {
    logger.error('Error cleaning up old usage data', error);
    throw error;
  }
}
