import { isVTTFile } from '@/utils/app/vttHandler';

import { describe, expect, it } from 'vitest';

function fileLike(name: string, type: string): File {
  return { name, type } as File;
}

describe('isVTTFile', () => {
  it('detects transcript extensions and MIME types', () => {
    expect(isVTTFile(fileLike('meeting.vtt', ''))).toBe(true);
    expect(isVTTFile(fileLike('meeting.srt', 'text/plain'))).toBe(true);
    expect(isVTTFile(fileLike('meeting', 'text/vtt'))).toBe(true);
    expect(isVTTFile(fileLike('meeting', 'application/x-subrip'))).toBe(true);
  });

  it('does not classify generic text or markdown documents as transcripts', () => {
    expect(isVTTFile(fileLike('notes.txt', 'text/plain'))).toBe(false);
    expect(isVTTFile(fileLike('README.md', 'text/plain'))).toBe(false);
    expect(isVTTFile(fileLike('README.markdown', 'text/markdown'))).toBe(false);
  });
});
