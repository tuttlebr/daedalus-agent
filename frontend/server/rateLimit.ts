import type { NextApiResponse } from 'next';

import { positiveIntegerFromEnv } from './config/env';
import { getRedis, sessionKey } from './session/redis';

import { createHash } from 'crypto';

export interface RateLimitRule {
  /** Bucket name, e.g. 'chat-async'. Used in the Redis key and error logs. */
  name: string;
  /** Maximum allowed requests per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Build a rate-limit rule whose limit/window can be overridden via env vars.
 * e.g. ruleFromEnv('chat-async', 'RATE_LIMIT_CHAT', 40, 60) reads
 * RATE_LIMIT_CHAT_MAX and RATE_LIMIT_CHAT_WINDOW_SECONDS.
 */
export function ruleFromEnv(
  name: string,
  envPrefix: string,
  defaultLimit: number,
  defaultWindowSeconds: number,
): RateLimitRule {
  return {
    name,
    limit: positiveIntegerFromEnv(`${envPrefix}_MAX`, defaultLimit),
    windowSeconds: positiveIntegerFromEnv(
      `${envPrefix}_WINDOW_SECONDS`,
      defaultWindowSeconds,
    ),
  };
}

function bucketKey(name: string, identity: string): string {
  const digest = createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, 32);
  return sessionKey(['ratelimit', name, digest]);
}

/**
 * Fixed-window counter. Increments the per-identity counter and sets the window
 * TTL on the first hit (mirrors the login throttle in pages/api/auth/login.ts).
 */
export async function checkRateLimit(
  rule: RateLimitRule,
  identity: string,
): Promise<RateLimitResult> {
  const redis = getRedis();
  const key = bucketKey(rule.name, identity);
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, rule.windowSeconds);
  }
  if (count > rule.limit) {
    const ttl = await redis.ttl(key);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: ttl > 0 ? ttl : rule.windowSeconds,
    };
  }
  return { allowed: true, remaining: rule.limit - count, retryAfterSeconds: 0 };
}

/**
 * Enforce a rate limit for the given identity, responding 429 when exceeded.
 * Returns true if the request may proceed.
 *
 * Fails OPEN on limiter errors (e.g. Redis unavailable) so the limiter can never
 * become a second source of outage; the failure is logged so the gap is visible.
 */
export async function enforceRateLimit(
  res: NextApiResponse,
  rule: RateLimitRule,
  identity: string,
): Promise<boolean> {
  let result: RateLimitResult;
  try {
    result = await checkRateLimit(rule, identity);
  } catch (error) {
    console.error(
      `[rate-limit] ${rule.name} check failed; allowing request`,
      error,
    );
    return true;
  }

  if (!result.allowed) {
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    res.status(429).json({
      error: 'Too many requests. Please slow down and try again shortly.',
      retryAfterSeconds: result.retryAfterSeconds,
    });
    return false;
  }
  return true;
}
