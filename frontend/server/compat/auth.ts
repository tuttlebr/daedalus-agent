import { CompatError } from './errors';

import { type ApiKeyPrincipal, verifyApiKey } from '@/server/apiKeys';
import type { IncomingHttpHeaders } from 'node:http';

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Authenticate a compatibility request by API key only. OpenAI clients send
 * `Authorization: Bearer`, Anthropic clients `x-api-key`; either is accepted
 * on every route, and two different keys are rejected. Browser sessions are
 * not accepted here, and caller-supplied Daedalus identity, scope, approval
 * or backend-authentication headers are never read: the job carries only the
 * principal resolved below.
 */
export async function authenticateCompatRequest(
  headers: IncomingHttpHeaders,
): Promise<ApiKeyPrincipal> {
  const authorization = single(headers.authorization)?.trim();
  const bearer = authorization
    ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1]
    : undefined;
  if (authorization && !bearer) {
    throw new CompatError(
      'authentication',
      'The Authorization header must use the Bearer scheme.',
    );
  }
  const apiKey = single(headers['x-api-key'])?.trim() || undefined;
  if (bearer && apiKey && bearer !== apiKey) {
    throw new CompatError(
      'invalid_request',
      'Conflicting credentials: send one API key in either Authorization or x-api-key.',
      { code: 'conflicting_credentials' },
    );
  }
  const presented = bearer ?? apiKey;
  if (!presented) {
    throw new CompatError(
      'authentication',
      'Missing API key. Create one in Daedalus under Connections, then send it as a Bearer token or x-api-key.',
    );
  }
  let principal: ApiKeyPrincipal | null;
  try {
    principal = await verifyApiKey(presented);
  } catch {
    throw new CompatError(
      'overloaded',
      'Authentication is temporarily unavailable. Try again.',
      { retryable: true, retryAfterSeconds: 2 },
    );
  }
  if (!principal) {
    throw new CompatError('authentication', 'Invalid API key.');
  }
  return principal;
}
