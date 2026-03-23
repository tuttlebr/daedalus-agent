/**
 * Magic byte validation for uploaded files.
 * Checks that file content matches claimed MIME type.
 */

// PDF: starts with %PDF
export function validatePdfMagicBytes(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
}

// ZIP (DOCX, PPTX, XLSX are ZIP-based): starts with PK (0x50 0x4B)
export function validateZipMagicBytes(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  return buffer[0] === 0x50 && buffer[1] === 0x4B && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) && (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08);
}

// Video formats
export function validateVideoMagicBytes(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;

  // MP4/MOV: ftyp box (offset 4-7)
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    return true;
  }

  // FLV: starts with FLV
  if (buffer[0] === 0x46 && buffer[1] === 0x4C && buffer[2] === 0x56) {
    return true;
  }

  // 3GP: also uses ftyp box
  // WebM/MKV: starts with 0x1A 0x45 0xDF 0xA3
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
    return true;
  }

  return false;
}

// HTML: check for common HTML patterns in first 1024 bytes
export function validateHtmlContent(buffer: Buffer): boolean {
  const head = buffer.slice(0, Math.min(1024, buffer.length)).toString('utf-8').toLowerCase().trim();
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<?xml') ||
    head.includes('<html')
  );
}

/**
 * Validate that a buffer matches the expected MIME type.
 * Returns true if valid, false if magic bytes don't match.
 */
export function validateMagicBytes(buffer: Buffer, mimeType: string): boolean {
  const mime = mimeType.toLowerCase();

  if (mime === 'application/pdf') {
    return validatePdfMagicBytes(buffer);
  }

  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return validateZipMagicBytes(buffer);
  }

  if (mime.startsWith('video/')) {
    return validateVideoMagicBytes(buffer);
  }

  if (mime === 'text/html' || mime === 'application/xhtml+xml') {
    return validateHtmlContent(buffer);
  }

  // Unknown type — allow (no validation rule)
  return true;
}
