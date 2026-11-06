import { CompatError } from './errors';

import type { IncomingMessage } from 'node:http';

/** JSON request bodies above this size are rejected before parsing. */
export const COMPAT_MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Read a bounded JSON body. The compatibility routes disable Next.js body
 * parsing so oversized and malformed bodies receive vendor-shaped errors.
 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = COMPAT_MAX_BODY_BYTES,
): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CompatError(
      'request_too_large',
      `Request body exceeds ${maxBytes} bytes.`,
      { code: 'request_too_large' },
    );
  }
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new CompatError(
        'request_too_large',
        `Request body exceeds ${maxBytes} bytes.`,
        { code: 'request_too_large' },
      );
    }
    parts.push(buffer);
  }
  const text = Buffer.concat(parts).toString('utf8');
  if (!text.trim()) {
    throw new CompatError(
      'invalid_request',
      'A JSON request body is required.',
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CompatError(
      'invalid_request',
      'The request body is not valid JSON.',
      { code: 'invalid_json' },
    );
  }
}
