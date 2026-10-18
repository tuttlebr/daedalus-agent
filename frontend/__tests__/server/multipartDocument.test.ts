// @vitest-environment node
import {
  getDocumentObjectConfig,
  putDocumentObject,
} from '@/server/documentObjectStore';
import {
  MultipartDocumentError,
  parseMultipartDocument,
} from '@/server/multipartDocument';
import { once } from 'node:events';
import http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BOUNDARY = 'review-boundary-7';

/** A browser multipart body whose closing boundary arrives after a delay. */
function delayedTrailerRequest(file: Buffer, trailer: string, delayMs: number) {
  const head = Buffer.from(
    `--${BOUNDARY}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="paper.pdf"\r\n' +
      'Content-Type: application/pdf\r\n\r\n',
  );
  const tail = Buffer.from(trailer);
  const req = Readable.from(
    (async function* () {
      yield Buffer.concat([head, file]);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield tail;
    })(),
  ) as any;
  req.headers = {
    'content-length': String(head.length + file.length + tail.length),
    'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    'x-document-size': String(file.length),
  };
  return req;
}

/** S3 commits an object as soon as it has every declared body byte. */
async function startObjectStore() {
  const committed: Buffer[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      committed.push(Buffer.concat(chunks));
      res.setHeader('ETag', '"etag-1"');
      res.statusCode = 200;
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP test server');
  }
  vi.stubEnv('DOCUMENT_OBJECT_ENDPOINT', `http://127.0.0.1:${address.port}`);
  vi.stubEnv('DOCUMENT_OBJECT_ACCESS_KEY', 'access');
  vi.stubEnv('DOCUMENT_OBJECT_SECRET_KEY', 'secret');
  vi.stubEnv('DOCUMENT_OBJECT_BUCKET', 'documents');
  return { committed, server };
}

async function upload(req: any) {
  const parsed = await parseMultipartDocument(req, 1024 * 1024);
  return putDocumentObject(
    {
      objectKey: 'daedalus-documents/owner/session-1/doc-1',
      contentType: parsed.mimeType,
      contentLength: parsed.size,
      expiresAt: 1,
      ownerId: 'alice',
      sessionId: 'session-1',
      documentId: 'doc-1',
      source: parsed.stream,
    },
    getDocumentObjectConfig(),
  );
}

describe('multipart document streaming into object storage', () => {
  let store: Awaited<ReturnType<typeof startObjectStore>>;

  beforeEach(async () => {
    store = await startObjectStore();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    store.server.close();
    await once(store.server, 'close');
  });

  it('completes a valid upload whose closing boundary arrives late', async () => {
    const file = Buffer.from('%PDF-late boundary payload');

    await expect(
      upload(delayedTrailerRequest(file, `\r\n--${BOUNDARY}--\r\n`, 150)),
    ).resolves.toEqual({ bucket: 'documents', etag: 'etag-1' });

    expect(store.committed).toEqual([file]);
  });

  it('never commits an object for a request with invalid multipart framing', async () => {
    const file = Buffer.from('%PDF-invalid trailer payload');

    const error = await upload(
      // Same length as a valid closing boundary, so only its bytes differ.
      delayedTrailerRequest(file, `\r\n--${BOUNDARY}!!\r\n`, 150),
    ).then(
      () => null,
      (reason: unknown) => reason,
    );

    // Give a server that already saw the full declared length time to commit.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.committed).toEqual([]);
    expect(error).toBeInstanceOf(MultipartDocumentError);
    expect((error as Error).message).toContain('invalid trailer');
  });
});
