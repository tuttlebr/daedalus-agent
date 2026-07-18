import { BACKEND_PORT, getBackendHost } from '@/utils/app/backendApi';

import {
  jsonDel,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';
import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';

const OAUTH_CALLBACK_TARGET_TTL_SECONDS = 11 * 60;

export interface OAuthCallbackTarget {
  backendBaseUrl: string;
  createdAt: number;
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
    const allowedHost =
      parsed.hostname === getBackendHost() || isPrivatePodIPv4(parsed.hostname);
    return (
      parsed.protocol === 'http:' &&
      port === String(BACKEND_PORT) &&
      allowedHost &&
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
): Promise<void> {
  if (!state || state.length > 512) {
    throw new Error('OAuth state is missing or too long');
  }
  if (!isAllowedOAuthBackendBaseUrl(backendBaseUrl)) {
    throw new Error('OAuth callback backend is not allowed');
  }
  await jsonSetWithExpiry(
    callbackTargetKey(state),
    { backendBaseUrl, createdAt: Date.now() } satisfies OAuthCallbackTarget,
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
    typeof target.createdAt !== 'number' ||
    !isAllowedOAuthBackendBaseUrl(target.backendBaseUrl)
  ) {
    return null;
  }
  return target;
}

export async function deleteOAuthCallbackTarget(state: string): Promise<void> {
  if (!state || state.length > 512) return;
  await jsonDel(callbackTargetKey(state));
}
