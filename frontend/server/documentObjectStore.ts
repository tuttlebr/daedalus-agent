import crypto from 'node:crypto';
import { once } from 'node:events';
import http, { type IncomingMessage, type RequestOptions } from 'node:http';
import https from 'node:https';

const MAX_ERROR_BODY_BYTES = 16 * 1024;
const DEFAULT_PREFIX = 'daedalus-documents';
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_REQUEST_TIMEOUT_MS = 100;
const MAX_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

export interface DocumentObjectConfig {
  endpoint: URL;
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
  bucket: string;
  region: string;
  prefix: string;
  requestTimeoutMs: number;
}

export interface PutDocumentObjectInput {
  objectKey: string;
  contentType: string;
  contentLength: number;
  expiresAt: number;
  ownerId: string;
  sessionId: string;
  documentId: string;
  source: AsyncIterable<Buffer>;
}

export interface PutDocumentObjectResult {
  bucket: string;
  etag?: string;
}

function requiredValue(name: string): string {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Document object storage is not configured: set ${name}`);
  }
  return value;
}

function optionalValue(name: string): string | undefined {
  const value = (process.env[name] || '').trim();
  return value || undefined;
}

function boundedIntegerValue(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizedEndpoint(raw: string): URL {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `http://${raw}`;
  const endpoint = new URL(withScheme);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('Document object storage endpoint is invalid');
  }
  return endpoint;
}

export function getDocumentObjectConfig(): DocumentObjectConfig {
  const prefix = (process.env.DOCUMENT_OBJECT_PREFIX || DEFAULT_PREFIX).trim();
  if (!SAFE_SEGMENT.test(prefix)) {
    throw new Error('DOCUMENT_OBJECT_PREFIX must be one safe path segment');
  }

  const bucket = requiredValue('DOCUMENT_OBJECT_BUCKET');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('Document object storage bucket name is invalid');
  }

  return {
    endpoint: normalizedEndpoint(
      requiredValue('DOCUMENT_OBJECT_ENDPOINT'),
    ),
    accessKey: requiredValue('DOCUMENT_OBJECT_ACCESS_KEY'),
    secretKey: requiredValue('DOCUMENT_OBJECT_SECRET_KEY'),
    sessionToken: optionalValue('DOCUMENT_OBJECT_SESSION_TOKEN'),
    bucket,
    region: (process.env.DOCUMENT_OBJECT_REGION || 'us-east-1').trim(),
    prefix,
    requestTimeoutMs: boundedIntegerValue(
      'DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS',
      DEFAULT_REQUEST_TIMEOUT_MS,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
    ),
  };
}

function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function documentOwnerHash(ownerId: string): string {
  if (!ownerId.trim()) throw new Error('Document owner is required');
  return crypto.createHash('sha256').update(ownerId).digest('hex').slice(0, 32);
}

export function buildDocumentObjectKey(
  ownerId: string,
  sessionId: string,
  documentId: string,
  config = getDocumentObjectConfig(),
): string {
  return [
    config.prefix,
    documentOwnerHash(ownerId),
    safeSegment(sessionId, 'Session ID'),
    safeSegment(documentId, 'Document ID'),
  ].join('/');
}

export function isExpectedDocumentObjectKey(
  objectKey: string,
  ownerId: string,
  sessionId: string,
  documentId: string,
  config = getDocumentObjectConfig(),
): boolean {
  try {
    return (
      objectKey ===
      buildDocumentObjectKey(ownerId, sessionId, documentId, config)
    );
  } catch {
    return false;
  }
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function amzTimestamp(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function encodedPath(config: DocumentObjectConfig, objectKey: string): string {
  const baseParts = config.endpoint.pathname.split('/').filter(Boolean);
  const parts = [...baseParts, config.bucket, ...objectKey.split('/')];
  return `/${parts.map((part) => encodeURIComponent(part)).join('/')}`;
}

function signedRequestOptions(
  method: 'PUT' | 'GET' | 'DELETE',
  objectKey: string,
  extraHeaders: Record<string, string>,
  config: DocumentObjectConfig,
): RequestOptions {
  const now = new Date();
  const timestamp = amzTimestamp(now);
  const date = timestamp.slice(0, 8);
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const path = encodedPath(config, objectKey);
  const headers: Record<string, string> = {
    host: config.endpoint.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
    ...extraHeaders,
  };
  if (config.sessionToken) {
    headers['x-amz-security-token'] = config.sessionToken;
  }

  const canonicalNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = canonicalNames
    .map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = canonicalNames.join(';');
  const canonicalRequest = [
    method,
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${date}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    sha256(canonicalRequest),
  ].join('\n');
  const dateKey = hmac(`AWS4${config.secretKey}`, date);
  const regionKey = hmac(dateKey, config.region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign).toString('hex');
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    protocol: config.endpoint.protocol,
    hostname: config.endpoint.hostname,
    port: config.endpoint.port || undefined,
    method,
    path,
    headers,
  };
}

function requestFor(
  options: RequestOptions,
  handler: (response: IncomingMessage) => void,
  timeoutMs: number,
) {
  const request =
    options.protocol === 'https:'
      ? https.request(options, handler)
      : http.request(options, handler);
  const deadline = setTimeout(() => {
    request.destroy(
      new Error(
        `Document object storage ${
          options.method || 'HTTP'
        } request timed out after ${timeoutMs}ms`,
      ),
    );
  }, timeoutMs);
  deadline.unref();
  request.once('close', () => clearTimeout(deadline));
  return request;
}

async function responseError(response: IncomingMessage): Promise<Error> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (length < MAX_ERROR_BODY_BYTES) {
      const remaining = MAX_ERROR_BODY_BYTES - length;
      chunks.push(chunk.subarray(0, remaining));
      length += Math.min(chunk.length, remaining);
    }
  }
  const detail = Buffer.concat(chunks).toString('utf8').trim();
  return new Error(
    `Document object storage returned ${response.statusCode || 500}${
      detail ? `: ${detail}` : ''
    }`,
  );
}

export async function putDocumentObject(
  input: PutDocumentObjectInput,
  config = getDocumentObjectConfig(),
): Promise<PutDocumentObjectResult> {
  const metadata = {
    'content-length': String(input.contentLength),
    'content-type': input.contentType,
    'x-amz-meta-document-id': input.documentId,
    'x-amz-meta-expires-at': String(input.expiresAt),
    'x-amz-meta-owner-hash': documentOwnerHash(input.ownerId),
    'x-amz-meta-session-id': input.sessionId,
  };
  const options = signedRequestOptions(
    'PUT',
    input.objectKey,
    metadata,
    config,
  );
  let responseResolve!: (response: IncomingMessage) => void;
  let responseReject!: (error: Error) => void;
  const responsePromise = new Promise<IncomingMessage>((resolve, reject) => {
    responseResolve = resolve;
    responseReject = reject;
  });
  const request = requestFor(options, responseResolve, config.requestTimeoutMs);
  request.once('error', responseReject);
  void responsePromise.catch(() => undefined);

  let written = 0;
  try {
    for await (const chunk of input.source) {
      written += chunk.length;
      if (written > input.contentLength) {
        throw new Error('Document stream exceeded its declared length');
      }
      if (!request.write(chunk)) await once(request, 'drain');
    }
    if (written !== input.contentLength) {
      throw new Error('Document stream ended before its declared length');
    }
    request.end();
    const response = await responsePromise;
    if (
      !response.statusCode ||
      response.statusCode < 200 ||
      response.statusCode >= 300
    ) {
      throw await responseError(response);
    }
    response.resume();
    return {
      bucket: config.bucket,
      ...(typeof response.headers.etag === 'string'
        ? { etag: response.headers.etag.replace(/^"|"$/g, '') }
        : {}),
    };
  } catch (error) {
    request.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

export async function getDocumentObject(
  objectKey: string,
  config = getDocumentObjectConfig(),
): Promise<IncomingMessage | null> {
  const options = signedRequestOptions('GET', objectKey, {}, config);
  return await new Promise((resolve, reject) => {
    const request = requestFor(
      options,
      (response) => {
        void (async () => {
          if (response.statusCode === 404) {
            response.resume();
            resolve(null);
            return;
          }
          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            reject(await responseError(response));
            return;
          }
          resolve(response);
        })().catch(reject);
      },
      config.requestTimeoutMs,
    );
    request.once('error', reject);
    request.end();
  });
}

export async function deleteDocumentObject(
  objectKey: string,
  config = getDocumentObjectConfig(),
): Promise<void> {
  const options = signedRequestOptions('DELETE', objectKey, {}, config);
  await new Promise<void>((resolve, reject) => {
    const request = requestFor(
      options,
      (response) => {
        void (async () => {
          if (
            response.statusCode === 404 ||
            (response.statusCode &&
              response.statusCode >= 200 &&
              response.statusCode < 300)
          ) {
            response.resume();
            resolve();
            return;
          }
          reject(await responseError(response));
        })().catch(reject);
      },
      config.requestTimeoutMs,
    );
    request.once('error', reject);
    request.end();
  });
}
