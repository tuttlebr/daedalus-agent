/**
 * Signed identity cookie — Edge runtime verification.
 *
 * This file contains ONLY Edge-compatible code (Web Crypto API, no Node.js
 * imports) so it can be safely imported from Edge API routes without pulling
 * ioredis, crypto, or other Node.js modules into the Edge bundle.
 */

const COOKIE_NAME = '__identity';

export interface IdentityPayload {
  username: string;
  userId: string;
  name: string;
}

/**
 * Verify the signed identity cookie (Edge runtime — chat handler).
 * Uses Web Crypto API (available in Edge) instead of Node.js crypto.
 * Returns the verified identity payload if valid, null otherwise.
 */
export async function verifyIdentityCookieEdge(
  cookieHeader: string | null,
): Promise<IdentityPayload | null> {
  if (!cookieHeader) return null;

  // Simple cookie parser (no external deps — safe for Edge)
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = pair.substring(0, eqIdx).trim();
    const value = pair.substring(eqIdx + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }

  const value = cookies[COOKIE_NAME];
  if (!value) return null;

  const dotIdx = value.lastIndexOf('.');
  if (dotIdx === -1) return null;

  const encodedPayload = value.substring(0, dotIdx);
  const providedSignature = value.substring(dotIdx + 1);

  const secret = process.env.SESSION_SECRET || 'daedalus-dev-identity-secret';

  // Compute expected HMAC-SHA256 using Web Crypto API
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(encodedPayload),
  );
  const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison to prevent timing attacks
  if (providedSignature.length !== expectedSignature.length) return null;
  let mismatch = 0;
  for (let i = 0; i < providedSignature.length; i++) {
    mismatch |= providedSignature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  if (mismatch !== 0) return null;

  try {
    // Decode base64url payload
    const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const decoded = atob(padded);
    return JSON.parse(decoded) as IdentityPayload;
  } catch {
    return null;
  }
}
