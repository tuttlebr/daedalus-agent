import {
  BACKEND_PORT,
  BACKEND_POD_PORT,
  getBackendHost,
} from '@/utils/app/backendApi';

import {
  jsonDel,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';
import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';

const OAUTH_CALLBACK_TARGET_TTL_SECONDS = 11 * 60;
const MAX_OAUTH_OWNER_CHARS = 256;

export interface OAuthCallbackTarget {
  backendBaseUrl: string;
  jobId: string;
  /**
   * Daedalus user that started the authorization. Targets written by older
   * stream workers omit it; their job request record names the owner instead.
   */
  userId?: string;
  createdAt: number;
}

function isValidOwner(userId: unknown): userId is string {
  return (
    typeof userId === 'string' &&
    userId.length > 0 &&
    userId.length <= MAX_OAUTH_OWNER_CHARS
  );
}

function callbackTargetKey(state: string): string {
  const stateHash = createHash('sha256').update(state).digest('hex');
  return sessionKey(['mcp-oauth-callback', stateHash]);
}

function isPrivatePodIPv4(hostname: string): boolean {
  if (!isIPv4(hostname)) return false;
  const [first, second] = hostname.split('.').map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

/**
 * Accept only the configured backend service or a private pod IP selected by
 * the trusted stream worker. This keeps a corrupted Redis value from turning
 * the public OAuth callback into an SSRF proxy.
 */
export function isAllowedOAuthBackendBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const port = parsed.port || (parsed.protocol === 'http:' ? '80' : '');
    const allowedTarget =
      parsed.hostname === getBackendHost()
        ? port === String(BACKEND_PORT)
        : isPrivatePodIPv4(parsed.hostname) &&
          port === String(BACKEND_POD_PORT);
    return (
      parsed.protocol === 'http:' &&
      allowedTarget &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

export async function saveOAuthCallbackTarget(
  state: string,
  backendBaseUrl: string,
  jobId: string,
  userId?: string,
): Promise<void> {
  if (!state || state.length > 512) {
    throw new Error('OAuth state is missing or too long');
  }
  if (!jobId || jobId.length > 128) {
    throw new Error('OAuth callback job is missing or too long');
  }
  if (userId !== undefined && !isValidOwner(userId)) {
    throw new Error('OAuth callback owner is invalid');
  }
  if (!isAllowedOAuthBackendBaseUrl(backendBaseUrl)) {
    throw new Error('OAuth callback backend is not allowed');
  }
  await jsonSetWithExpiry(
    callbackTargetKey(state),
    {
      backendBaseUrl,
      jobId,
      ...(userId ? { userId } : {}),
      createdAt: Date.now(),
    } satisfies OAuthCallbackTarget,
    OAUTH_CALLBACK_TARGET_TTL_SECONDS,
  );
}

export async function loadOAuthCallbackTarget(
  state: string,
): Promise<OAuthCallbackTarget | null> {
  if (!state || state.length > 512) return null;
  const target = (await jsonGet(
    callbackTargetKey(state),
  )) as OAuthCallbackTarget | null;
  if (
    !target ||
    typeof target.backendBaseUrl !== 'string' ||
    typeof target.jobId !== 'string' ||
    !target.jobId ||
    target.jobId.length > 128 ||
    typeof target.createdAt !== 'number' ||
    (target.userId !== undefined && !isValidOwner(target.userId)) ||
    !isAllowedOAuthBackendBaseUrl(target.backendBaseUrl)
  ) {
    return null;
  }
  return target;
}

/**
 * The backend stores a completed grant under the user who started the flow,
 * whichever browser consents. Only that user's signed-in session may deliver
 * the callback; otherwise a forwarded consent link would attach another
 * person's Google account to the initiator.
 */
export async function isOAuthCallbackOwner(
  target: OAuthCallbackTarget,
  userId: string,
): Promise<boolean> {
  if (!userId) return false;
  if (target.userId !== undefined) return target.userId === userId;
  const job = (await jsonGet(
    sessionKey(['async-job-request', target.jobId]),
  )) as { userId?: unknown } | null;
  return job?.userId === userId;
}

export async function deleteOAuthCallbackTarget(state: string): Promise<void> {
  if (!state || state.length > 512) return;
  await jsonDel(callbackTargetKey(state));
}
