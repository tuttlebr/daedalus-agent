import { describe, it, expect } from 'vitest';
import {
  validatePdfMagicBytes,
  validateZipMagicBytes,
  validateVideoMagicBytes,
  validateHtmlContent,
  validateMagicBytes,
} from '@/utils/app/magicBytes';

describe('validatePdfMagicBytes', () => {
  it('accepts a valid %PDF header', () => {
    // %PDF = 0x25 0x50 0x44 0x46
    const buf = Buffer.from('%PDF-1.7 rest of file', 'utf-8');
    expect(validatePdfMagicBytes(buf)).toBe(true);
  });

  it('accepts minimal %PDF (exactly 4 bytes)', () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46]);
    expect(validatePdfMagicBytes(buf)).toBe(true);
  });

  it('rejects random bytes', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
    expect(validatePdfMagicBytes(buf)).toBe(false);
  });

  it('rejects a buffer shorter than 4 bytes', () => {
    const buf = Buffer.from([0x25, 0x50, 0x44]);
    expect(validatePdfMagicBytes(buf)).toBe(false);
  });

  it('rejects an empty buffer', () => {
    const buf = Buffer.alloc(0);
    expect(validatePdfMagicBytes(buf)).toBe(false);
  });

  it('rejects a buffer that starts with nearly-correct bytes', () => {
    // %PDG instead of %PDF
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x47]);
    expect(validatePdfMagicBytes(buf)).toBe(false);
  });
});

describe('validateZipMagicBytes', () => {
  it('accepts PK\\x03\\x04 header (standard ZIP local file header)', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    expect(validateZipMagicBytes(buf)).toBe(true);
  });

  it('accepts PK\\x05\\x06 header (end of central directory)', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00]);
    expect(validateZipMagicBytes(buf)).toBe(true);
  });

  it('accepts PK\\x07\\x08 header (data descriptor)', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x07, 0x08, 0x00, 0x00]);
    expect(validateZipMagicBytes(buf)).toBe(true);
  });

  it('rejects random bytes', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(validateZipMagicBytes(buf)).toBe(false);
  });

  it('rejects a buffer shorter than 4 bytes', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03]);
    expect(validateZipMagicBytes(buf)).toBe(false);
  });

  it('rejects PK with unexpected third/fourth bytes', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    expect(validateZipMagicBytes(buf)).toBe(false);
  });

  it('works for DOCX-like files (ZIP-based office formats)', () => {
    // A real DOCX starts with PK\x03\x04
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
    expect(validateZipMagicBytes(buf)).toBe(true);
  });
});

describe('validateVideoMagicBytes', () => {
  it('accepts MP4 ftyp header', () => {
    // MP4: bytes 4-7 are "ftyp" (0x66 0x74 0x79 0x70)
    const buf = Buffer.alloc(12, 0);
    buf[4] = 0x66; // f
    buf[5] = 0x74; // t
    buf[6] = 0x79; // y
    buf[7] = 0x70; // p
    expect(validateVideoMagicBytes(buf)).toBe(true);
  });

  it('accepts FLV header', () => {
    // FLV: starts with 0x46 0x4C 0x56
    const buf = Buffer.alloc(12, 0);
    buf[0] = 0x46; // F
    buf[1] = 0x4c; // L
    buf[2] = 0x56; // V
    expect(validateVideoMagicBytes(buf)).toBe(true);
  });

  it('accepts WebM/MKV header', () => {
    // WebM: starts with 0x1A 0x45 0xDF 0xA3
    const buf = Buffer.alloc(12, 0);
    buf[0] = 0x1a;
    buf[1] = 0x45;
    buf[2] = 0xdf;
    buf[3] = 0xa3;
    expect(validateVideoMagicBytes(buf)).toBe(true);
  });

  it('rejects random bytes', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
    expect(validateVideoMagicBytes(buf)).toBe(false);
  });

  it('rejects a buffer shorter than 12 bytes', () => {
    const buf = Buffer.from([0x66, 0x74, 0x79, 0x70]);
    expect(validateVideoMagicBytes(buf)).toBe(false);
  });

  it('rejects an empty buffer', () => {
    const buf = Buffer.alloc(0);
    expect(validateVideoMagicBytes(buf)).toBe(false);
  });

  it('accepts a real MP4-like buffer with ftypisom', () => {
    // Typical MP4 header: size (4 bytes) + "ftyp" + brand
    const buf = Buffer.alloc(16, 0);
    buf.writeUInt32BE(16, 0); // box size
    buf.write('ftypisom', 4, 'ascii'); // ftyp + brand
    expect(validateVideoMagicBytes(buf)).toBe(true);
  });
});

describe('validateHtmlContent', () => {
  it('accepts <!DOCTYPE html>', () => {
    const buf = Buffer.from('<!DOCTYPE html><html><head></head><body></body></html>');
    expect(validateHtmlContent(buf)).toBe(true);
  });

  it('accepts <!doctype html> (case-insensitive)', () => {
    const buf = Buffer.from('<!doctype html><html></html>');
    expect(validateHtmlContent(buf)).toBe(true);
  });

  it('accepts content starting with <html', () => {
    const buf = Buffer.from('<html lang="en"><head></head><body></body></html>');
    expect(validateHtmlContent(buf)).toBe(true);
  });

  it('accepts content starting with <?xml (XHTML)', () => {
    const buf = Buffer.from('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"></html>');
    expect(validateHtmlContent(buf)).toBe(true);
  });

  it('accepts content that contains <html> somewhere in the first 1024 bytes', () => {
    const buf = Buffer.from('  \n\n  <!-- comment --><html><body></body></html>');
    expect(validateHtmlContent(buf)).toBe(true);
  });

  it('rejects non-HTML plain text', () => {
    const buf = Buffer.from('This is just a regular text file with no HTML.');
    expect(validateHtmlContent(buf)).toBe(false);
  });

  it('rejects JSON content', () => {
    const buf = Buffer.from('{"key": "value", "list": [1, 2, 3]}');
    expect(validateHtmlContent(buf)).toBe(false);
  });

  it('rejects an empty buffer', () => {
    const buf = Buffer.alloc(0);
    expect(validateHtmlContent(buf)).toBe(false);
  });

  it('only examines the first 1024 bytes', () => {
    // <html> beyond byte 1024 should not match since head is trimmed
    const padding = 'x'.repeat(1100);
    const buf = Buffer.from(padding + '<html></html>');
    expect(validateHtmlContent(buf)).toBe(false);
  });
});

describe('validateMagicBytes', () => {
  const pdfBuffer = Buffer.from('%PDF-1.7', 'utf-8');
  const zipBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  const mp4Buffer = (() => {
    const b = Buffer.alloc(12, 0);
    b[4] = 0x66;
    b[5] = 0x74;
    b[6] = 0x79;
    b[7] = 0x70;
    return b;
  })();
  const htmlBuffer = Buffer.from('<!DOCTYPE html><html></html>');
  const randomBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);

  it('routes application/pdf to PDF validator', () => {
    expect(validateMagicBytes(pdfBuffer, 'application/pdf')).toBe(true);
    expect(validateMagicBytes(randomBuffer, 'application/pdf')).toBe(false);
  });

  it('routes DOCX MIME type to ZIP validator', () => {
    const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(validateMagicBytes(zipBuffer, mime)).toBe(true);
    expect(validateMagicBytes(randomBuffer, mime)).toBe(false);
  });

  it('routes PPTX MIME type to ZIP validator', () => {
    const mime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    expect(validateMagicBytes(zipBuffer, mime)).toBe(true);
    expect(validateMagicBytes(randomBuffer, mime)).toBe(false);
  });

  it('routes XLSX MIME type to ZIP validator', () => {
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    expect(validateMagicBytes(zipBuffer, mime)).toBe(true);
    expect(validateMagicBytes(randomBuffer, mime)).toBe(false);
  });

  it('routes video/* to video validator', () => {
    expect(validateMagicBytes(mp4Buffer, 'video/mp4')).toBe(true);
    expect(validateMagicBytes(mp4Buffer, 'video/webm')).toBe(true);
    expect(validateMagicBytes(randomBuffer, 'video/mp4')).toBe(false);
  });

  it('routes text/html to HTML validator', () => {
    expect(validateMagicBytes(htmlBuffer, 'text/html')).toBe(true);
    expect(validateMagicBytes(randomBuffer, 'text/html')).toBe(false);
  });

  it('routes application/xhtml+xml to HTML validator', () => {
    const xhtmlBuffer = Buffer.from('<?xml version="1.0"?><html></html>');
    expect(validateMagicBytes(xhtmlBuffer, 'application/xhtml+xml')).toBe(true);
  });

  it('returns true for unknown MIME types (no validation rule)', () => {
    expect(validateMagicBytes(randomBuffer, 'application/octet-stream')).toBe(true);
    expect(validateMagicBytes(randomBuffer, 'text/plain')).toBe(true);
    expect(validateMagicBytes(randomBuffer, 'image/png')).toBe(true);
  });

  it('is case-insensitive for MIME type matching', () => {
    expect(validateMagicBytes(pdfBuffer, 'Application/PDF')).toBe(true);
    expect(validateMagicBytes(zipBuffer, 'APPLICATION/VND.OPENXMLFORMATS-OFFICEDOCUMENT.WORDPROCESSINGML.DOCUMENT')).toBe(true);
    expect(validateMagicBytes(mp4Buffer, 'Video/MP4')).toBe(true);
    expect(validateMagicBytes(htmlBuffer, 'TEXT/HTML')).toBe(true);
  });
});
