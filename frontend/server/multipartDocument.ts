import type { NextApiRequest } from 'next';

import { validateMagicBytes } from '@/utils/app/magicBytes';

const MAX_BOUNDARY_CHARS = 70;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_FILENAME_CHARS = 512;
const MAX_MIME_TYPE_CHARS = 255;
const MAGIC_PREFIX_BYTES = 1024;
const SAFE_BOUNDARY = /^[0-9A-Za-z'()+_,./:=?-]+$/;
const DOCUMENT_MIME_BY_EXTENSION: Record<string, string> = {
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.markdown': 'text/markdown',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
};
const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  ...Object.values(DOCUMENT_MIME_BY_EXTENSION),
  'application/xhtml+xml',
  'text/x-markdown',
]);

export const DOCUMENT_MULTIPART_OVERHEAD_BYTES = MAX_MULTIPART_OVERHEAD_BYTES;

export class MultipartDocumentError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'MultipartDocumentError';
    this.status = status;
  }
}

export interface ParsedMultipartDocument {
  filename: string;
  mimeType: string;
  size: number;
  stream: AsyncIterable<Buffer>;
}

function singleHeader(
  value: string | string[] | undefined,
  label: string,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MultipartDocumentError(400, `${label} header is required`);
  }
  return value.trim();
}

function parseBoundary(contentType: string): string {
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] || match?.[2] || '';
  if (
    !contentType.toLowerCase().startsWith('multipart/form-data') ||
    !boundary ||
    boundary.length > MAX_BOUNDARY_CHARS ||
    !SAFE_BOUNDARY.test(boundary)
  ) {
    throw new MultipartDocumentError(
      415,
      'Content-Type must be multipart/form-data with a valid boundary',
    );
  }
  return boundary;
}

function parseContentLength(req: NextApiRequest, maxBytes: number): number {
  if (req.headers['transfer-encoding'] || req.headers['content-encoding']) {
    throw new MultipartDocumentError(
      400,
      'Document uploads require an exact unencoded Content-Length',
    );
  }
  const raw = singleHeader(req.headers['content-length'], 'Content-Length');
  if (!/^[0-9]+$/.test(raw)) {
    throw new MultipartDocumentError(400, 'Content-Length is invalid');
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new MultipartDocumentError(400, 'Content-Length is invalid');
  }
  if (length > maxBytes + MAX_MULTIPART_OVERHEAD_BYTES) {
    throw new MultipartDocumentError(
      413,
      'Document size exceeds maximum allowed size',
    );
  }
  return length;
}

function parseDocumentLength(req: NextApiRequest, maxBytes: number): number {
  const raw = singleHeader(req.headers['x-document-size'], 'X-Document-Size');
  if (!/^[0-9]+$/.test(raw)) {
    throw new MultipartDocumentError(400, 'X-Document-Size is invalid');
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new MultipartDocumentError(400, 'Uploaded document is empty');
  }
  if (length > maxBytes) {
    throw new MultipartDocumentError(
      413,
      'Document size exceeds maximum allowed size',
    );
  }
  return length;
}

function parsePartHeaders(raw: string): { filename: string; mimeType: string } {
  const lines = raw.split('\r\n');
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new MultipartDocumentError(
        400,
        'Multipart part headers are invalid',
      );
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    if (headers.has(name)) {
      throw new MultipartDocumentError(400, 'Duplicate multipart part header');
    }
    headers.set(name, line.slice(separator + 1).trim());
  }

  const disposition = headers.get('content-disposition') || '';
  if (!/^form-data(?:;|$)/i.test(disposition)) {
    throw new MultipartDocumentError(
      400,
      'Multipart file disposition is invalid',
    );
  }
  const nameMatch = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition);
  const filenameMatch = /(?:^|;)\s*filename="((?:\\.|[^"])*)"/i.exec(
    disposition,
  );
  if (nameMatch?.[1] !== 'file' || !filenameMatch) {
    throw new MultipartDocumentError(400, 'A single file field is required');
  }
  const suppliedFilename = filenameMatch[1].replace(/\\(["\\])/g, '$1');
  const utf8Filename = Buffer.from(suppliedFilename, 'latin1').toString('utf8');
  const decodedFilename = utf8Filename.includes('\ufffd')
    ? suppliedFilename
    : utf8Filename;
  const filename = decodedFilename.split(/[\\/]/).pop()?.trim() || '';
  if (
    !filename ||
    filename.length > MAX_FILENAME_CHARS ||
    /[\u0000-\u001f\u007f]/.test(filename)
  ) {
    throw new MultipartDocumentError(400, 'Filename is invalid');
  }

  let mimeType = (headers.get('content-type') || 'application/octet-stream')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (
    !mimeType ||
    mimeType.length > MAX_MIME_TYPE_CHARS ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)
  ) {
    throw new MultipartDocumentError(400, 'MIME type is invalid');
  }
  if (mimeType === 'application/octet-stream') {
    const dot = filename.lastIndexOf('.');
    const extension = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
    mimeType = DOCUMENT_MIME_BY_EXTENSION[extension] || mimeType;
  }
  if (!ALLOWED_DOCUMENT_MIME_TYPES.has(mimeType)) {
    throw new MultipartDocumentError(415, 'Unsupported document MIME type');
  }
  return { filename, mimeType };
}

function asBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
}

export async function parseMultipartDocument(
  req: NextApiRequest,
  maxBytes: number,
): Promise<ParsedMultipartDocument> {
  const contentLength = parseContentLength(req, maxBytes);
  const size = parseDocumentLength(req, maxBytes);
  const boundary = parseBoundary(
    singleHeader(req.headers['content-type'], 'Content-Type'),
  );
  const opening = `--${boundary}\r\n`;
  const trailer = Buffer.from(`\r\n--${boundary}--`);
  const trailerWithCrlf = Buffer.from(`\r\n--${boundary}--\r\n`);
  const iterator = req[Symbol.asyncIterator]();

  let consumed = 0;
  let buffered = Buffer.alloc(0);
  let headerEnd = -1;
  while (headerEnd < 0) {
    const next = await iterator.next();
    if (next.done) {
      throw new MultipartDocumentError(
        400,
        'Multipart upload ended before file data',
      );
    }
    const chunk = asBuffer(next.value);
    consumed += chunk.length;
    if (consumed > contentLength) {
      throw new MultipartDocumentError(400, 'Upload exceeded Content-Length');
    }
    buffered = Buffer.concat([buffered, chunk]);
    headerEnd = buffered.indexOf('\r\n\r\n');
    if (
      (headerEnd < 0 && buffered.length > MAX_HEADER_BYTES) ||
      headerEnd > MAX_HEADER_BYTES
    ) {
      throw new MultipartDocumentError(400, 'Multipart headers are too large');
    }
  }

  const bodyOffset = headerEnd + 4;
  const rawHeaders = buffered.subarray(0, headerEnd).toString('latin1');
  if (rawHeaders.split('\r\n', 1)[0] !== opening.slice(0, -2)) {
    throw new MultipartDocumentError(400, 'Multipart boundary is invalid');
  }
  const { filename, mimeType } = parsePartHeaders(rawHeaders);
  const expectedOverhead = contentLength - size;
  if (
    expectedOverhead !== bodyOffset + trailer.length &&
    expectedOverhead !== bodyOffset + trailerWithCrlf.length
  ) {
    throw new MultipartDocumentError(
      400,
      'Multipart framing does not match the declared document size',
    );
  }

  buffered = buffered.subarray(bodyOffset);
  const prefixLength = Math.min(size, MAGIC_PREFIX_BYTES);
  while (buffered.length < prefixLength) {
    const next = await iterator.next();
    if (next.done) {
      throw new MultipartDocumentError(
        400,
        'Upload ended before document data',
      );
    }
    const chunk = asBuffer(next.value);
    consumed += chunk.length;
    if (consumed > contentLength) {
      throw new MultipartDocumentError(400, 'Upload exceeded Content-Length');
    }
    buffered = Buffer.concat([buffered, chunk]);
  }
  if (!validateMagicBytes(buffered.subarray(0, prefixLength), mimeType)) {
    throw new MultipartDocumentError(
      415,
      'File content does not match claimed MIME type',
    );
  }

  async function* documentStream(): AsyncGenerator<Buffer> {
    let fileRemaining = size;
    let current = buffered;
    let finalBytes = Buffer.alloc(0);

    while (true) {
      if (current.length > 0) {
        const fileBytes = current.subarray(
          0,
          Math.min(fileRemaining, current.length),
        );
        if (fileBytes.length > 0) {
          fileRemaining -= fileBytes.length;
          yield fileBytes;
        }
        if (current.length > fileBytes.length) {
          finalBytes = Buffer.concat([
            finalBytes,
            current.subarray(fileBytes.length),
          ]);
        }
      }
      if (fileRemaining === 0 && consumed === contentLength) break;

      const next = await iterator.next();
      if (next.done) break;
      current = asBuffer(next.value);
      consumed += current.length;
      if (consumed > contentLength) {
        throw new MultipartDocumentError(400, 'Upload exceeded Content-Length');
      }
    }

    if (fileRemaining !== 0 || consumed !== contentLength) {
      throw new MultipartDocumentError(
        400,
        'Upload length did not match Content-Length',
      );
    }
    if (!finalBytes.equals(trailer) && !finalBytes.equals(trailerWithCrlf)) {
      throw new MultipartDocumentError(
        400,
        'Multipart upload has an invalid trailer',
      );
    }
    const extra = await iterator.next();
    if (!extra.done) {
      throw new MultipartDocumentError(
        400,
        'Upload contained data after the final boundary',
      );
    }
  }

  return { filename, mimeType, size, stream: documentStream() };
}
