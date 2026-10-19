import type Redis from 'ioredis';
import { createHash } from 'node:crypto';

export interface RedisScript {
  readonly source: string;
  readonly sha: string;
}

const registered = new Map<string, string>();

/** A Lua script identified by its SHA-1 digest, as Redis caches it. */
export function redisScript(source: string): RedisScript {
  const sha = createHash('sha1').update(source).digest('hex');
  registered.set(sha, source);
  return { source, sha };
}

/** The source of a script defined here, for labelling traced commands. */
export function registeredScriptSource(sha: string): string | undefined {
  return registered.get(sha);
}

function isNoScriptError(error: unknown): boolean {
  return (
    error instanceof Error && /^NOSCRIPT\b/.test(error.message.trimStart())
  );
}

/**
 * Run a script by digest and send its body only when this Redis has not
 * cached it (after a restart or SCRIPT FLUSH). NOSCRIPT means nothing ran, so
 * the EVAL retry cannot repeat a write. Used for scripts called on every
 * stream flush, heartbeat, status poll or subscription, where the body
 * dominated the bytes sent.
 */
export async function evalScript(
  client: Redis,
  script: RedisScript,
  numKeys: number,
  ...args: Array<string | number>
): Promise<unknown> {
  try {
    return await client.evalsha(script.sha, numKeys, ...args);
  } catch (error) {
    if (!isNoScriptError(error)) throw error;
    return client.eval(script.source, numKeys, ...args);
  }
}
