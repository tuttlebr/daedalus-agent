import { sessionKey } from '@/server/session/redis';

/**
 * Helpers shared by the image generate/edit/jobs routes.
 *
 * These were byte-identical copies in three route files. Duplicating
 * `UNSAFE_BROWSER_KEYS` in particular is a credential-leak hazard: adding a key
 * name in one route and not the others silently forwards it to the backend.
 */
const UNSAFE_BROWSER_KEYS = [
  'apiKey',
  'openaiApiKey',
  'openai_api_key',
  'OPENAI_API_KEY',
  'authorization',
  'Authorization',
];

export function removeUnsafeBrowserKeys(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...body };
  for (const key of UNSAFE_BROWSER_KEYS) {
    delete next[key];
  }
  return next;
}

export function isBackendUnavailable(message: string): boolean {
  return (
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND') ||
    message.includes('EAI_AGAIN') ||
    message.includes('ECONNRESET') ||
    message.includes('socket hang up')
  );
}

/**
 * Image-panel history is keyed by user when one is authenticated, and by
 * session otherwise. Two copies of this builder would split a user's history
 * across two Redis keys without any error.
 */
export function imageHistoryKey(userId: string, sessionId: string): string {
  if (userId && userId !== 'anon') {
    return sessionKey(['user', userId, 'imagePanelHistory']);
  }
  return sessionKey(['session', sessionId, 'imagePanelHistory']);
}
