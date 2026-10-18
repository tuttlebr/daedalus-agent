import { waitForHttp } from './wait-for-http.mjs';

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function amzTimestamp(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function request(options, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const client = options.protocol === 'https:' ? https : http;
    const req = client.request(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.on('end', () =>
        resolve({
          status: response.statusCode || 500,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    const timeout = setTimeout(
      () => req.destroy(new Error('S3 fixture request timed out')),
      timeoutMs,
    );
    req.once('close', () => clearTimeout(timeout));
    req.once('error', reject);
    req.end();
  });
}

export function waitForS3(
  endpoint = 'http://127.0.0.1:18333',
  timeoutMs = 60_000,
) {
  const healthUrl = new URL('/', endpoint);
  return waitForHttp(healthUrl, timeoutMs);
}

export async function ensureS3Bucket({
  endpoint = 'http://127.0.0.1:18333',
  accessKey = 'e2e-s3-access',
  secretKey = 'e2e-s3-secret-key',
  bucket = 'daedalus-e2e-documents',
  region = 'us-east-1',
  timeoutMs = 30_000,
} = {}) {
  const target = new URL(endpoint);
  const now = new Date();
  const timestamp = amzTimestamp(now);
  const date = timestamp.slice(0, 8);
  const path = `/${encodeURIComponent(bucket)}`;
  const payloadHash = sha256('');
  const headers = {
    host: target.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');
  const canonicalRequest = [
    'PUT',
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    sha256(canonicalRequest),
  ].join('\n');
  const dateKey = hmac(`AWS4${secretKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign).toString('hex');
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const result = await request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: 'PUT',
      path,
      headers,
    },
    timeoutMs,
  );
  if (result.status >= 200 && result.status < 300) return;
  if (
    result.status === 409 &&
    /BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(result.body)
  ) {
    return;
  }
  throw new Error(
    `Unable to create S3 bucket ${bucket}: ${result.status} ${result.body}`,
  );
}
