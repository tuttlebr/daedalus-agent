import { describe, expect, it } from 'vitest';

import { UPLOAD_LIMITS, getFileSizeLimit } from '@/constants/uploadLimits';

function fileLike(name: string, type: string): File {
  return { name, type } as File;
}

describe('getFileSizeLimit', () => {
  it('classifies markdown files as documents', () => {
    expect(getFileSizeLimit(fileLike('notes.md', ''))).toBe(
      UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES,
    );
    expect(getFileSizeLimit(fileLike('README.markdown', 'text/markdown'))).toBe(
      UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES,
    );
    expect(getFileSizeLimit(fileLike('notes', 'text/x-markdown'))).toBe(
      UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES,
    );
  });

  it('classifies plain text files as documents', () => {
    expect(getFileSizeLimit(fileLike('notes.txt', ''))).toBe(
      UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES,
    );
    expect(getFileSizeLimit(fileLike('notes', 'text/plain'))).toBe(
      UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES,
    );
  });
});
