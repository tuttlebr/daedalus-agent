import { ECDH } from 'node:crypto';

// These provider-controlled domains are also the Helm Cilium egress allowlist.
// No request- or environment-controlled destination exception is supported.
export const PUSH_PROVIDER_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
] as const;
export const PUSH_PROVIDER_SUFFIX = '.push.apple.com';
export const MAX_PUSH_SUBSCRIPTIONS = 20;

export interface SafePushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

function decodeKey(value: unknown, bytes: number): Buffer | null {
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(value)
  )
    return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === bytes ? decoded : null;
}

export function parsePushSubscription(
  value: unknown,
): SafePushSubscription | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, any>;
  if (typeof input.endpoint !== 'string' || input.endpoint.length > 4096)
    return null;
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    return null;
  }
  const host = endpoint.hostname;
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.pathname === '/'
  )
    return null;
  if (
    !(PUSH_PROVIDER_HOSTS as readonly string[]).includes(host) &&
    !(
      host.endsWith(PUSH_PROVIDER_SUFFIX) &&
      /^[a-z0-9.-]+$/.test(host) &&
      host.length > PUSH_PROVIDER_SUFFIX.length
    )
  )
    return null;
  const publicKey = decodeKey(input.keys?.p256dh, 65);
  if (!publicKey || publicKey[0] !== 4 || !decodeKey(input.keys?.auth, 16))
    return null;
  try {
    ECDH.convertKey(publicKey, 'prime256v1');
  } catch {
    return null;
  }
  if (
    input.expirationTime != null &&
    (typeof input.expirationTime !== 'number' ||
      !Number.isFinite(input.expirationTime) ||
      input.expirationTime <= 0)
  )
    return null;
  return {
    endpoint: endpoint.href,
    keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
    ...(input.expirationTime === undefined
      ? {}
      : { expirationTime: input.expirationTime }),
  };
}
