import { applyStreamingContentDelta } from '@/utils/app/streamingContent';

import { describe, expect, it } from 'vitest';

describe('streaming content assembly', () => {
  it('preserves repeated characters split across token boundaries', () => {
    let content = '';
    let responseStart = 0;
    for (const delta of ['documentId=0f202', '2fff5fe6', 'ccda1700', '0daf']) {
      content = applyStreamingContentDelta(content, delta, responseStart);
      responseStart += delta.length;
    }

    expect(content).toBe('documentId=0f2022fff5fe6ccda17000daf');
  });

  it('ignores a token already included by a cumulative status update', () => {
    expect(applyStreamingContentDelta('Hello', 'lo', 3)).toBe('Hello');
  });

  it('waits for cumulative state when a token arrives with a gap', () => {
    expect(applyStreamingContentDelta('Hello', 'world', 7)).toBe('Hello');
  });

  it('concatenates legacy events that have no canonical offset', () => {
    expect(applyStreamingContentDelta('book', 'keeper')).toBe('bookkeeper');
  });
});
