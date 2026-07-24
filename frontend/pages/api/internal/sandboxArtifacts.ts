import type { NextApiRequest, NextApiResponse } from 'next';

import {
  SANDBOX_ARTIFACT_MAX_BYTES,
  storeSandboxArtifact,
} from '@/server/sandboxArtifactStore';
import { timingSafeEqual } from 'node:crypto';

class SandboxArtifactRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'SandboxArtifactRequestError';
  }
}

function header(req: NextApiRequest, name: string): string {
  const value = req.headers[name];
  return typeof value === 'string' ? value : '';
}

function hasValidInternalToken(req: NextApiRequest): boolean {
  const expected = process.env.DAEDALUS_INTERNAL_API_TOKEN?.trim();
  const provided = header(req, 'x-daedalus-internal-token');
  if (!expected || !provided) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}

function decodeBase64UrlHeader(
  req: NextApiRequest,
  name: string,
  label: string,
  maxBytes: number,
): string {
  const encoded = header(req, name);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new SandboxArtifactRequestError(400, `${label} is invalid`);
  }
  const decoded = Buffer.from(encoded, 'base64url');
  if (
    decoded.length < 1 ||
    decoded.length > maxBytes ||
    decoded.toString('base64url') !== encoded
  ) {
    throw new SandboxArtifactRequestError(400, `${label} is invalid`);
  }
  const value = decoded.toString('utf8');
  if (Buffer.from(value, 'utf8').toString('base64url') !== encoded) {
    throw new SandboxArtifactRequestError(400, `${label} is invalid`);
  }
  return value;
}

function declaredContentLength(req: NextApiRequest): number {
  const raw = header(req, 'content-length');
  if (!/^\d+$/.test(raw)) {
    throw new SandboxArtifactRequestError(
      411,
      'A valid Content-Length header is required',
    );
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new SandboxArtifactRequestError(400, 'Artifact size is invalid');
  }
  if (length > SANDBOX_ARTIFACT_MAX_BYTES) {
    throw new SandboxArtifactRequestError(413, 'Artifact is too large');
  }
  return length;
}

async function readExactBody(
  req: NextApiRequest,
  expectedLength: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    received += chunk.length;
    if (received > expectedLength || received > SANDBOX_ARTIFACT_MAX_BYTES) {
      throw new SandboxArtifactRequestError(
        413,
        'Artifact body exceeded its declared size',
      );
    }
    chunks.push(chunk);
  }
  if (received !== expectedLength) {
    throw new SandboxArtifactRequestError(
      400,
      'Artifact body did not match its declared size',
    );
  }
  return Buffer.concat(chunks, received);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!hasValidInternalToken(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (header(req, 'content-type') !== 'application/octet-stream') {
    return res.status(415).json({ error: 'Unsupported media type' });
  }

  try {
    const ownerId = decodeBase64UrlHeader(
      req,
      'x-daedalus-owner-id-b64',
      'Artifact owner',
      512,
    );
    const conversationId = decodeBase64UrlHeader(
      req,
      'x-daedalus-conversation-id-b64',
      'Conversation ID',
      512,
    );
    const filePath = decodeBase64UrlHeader(
      req,
      'x-daedalus-artifact-path-b64',
      'Artifact path',
      1024,
    );
    const content = await readExactBody(req, declaredContentLength(req));
    const artifact = await storeSandboxArtifact({
      ownerId,
      conversationId,
      filePath,
      content,
    });
    return res.status(201).json({ artifact });
  } catch (error) {
    if (error instanceof SandboxArtifactRequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Failed to publish a sandbox artifact:', error);
    return res.status(500).json({ error: 'Artifact publication failed' });
  }
}

export const config = {
  api: {
    bodyParser: false,
    responseLimit: '1mb',
  },
  maxDuration: 120,
};
