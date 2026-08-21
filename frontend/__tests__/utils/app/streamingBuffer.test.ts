import { reduceStreamingUpdates } from '@/utils/app/streamingBuffer';

import { describe, expect, it } from 'vitest';

describe('streaming update buffering', () => {
  it('assembles ordered canonical deltas in one render batch', () => {
    expect(
      reduceStreamingUpdates('', [
        { content: 'Hello', responseStart: 0 },
        { content: ' world', responseStart: 5 },
      ]),
    ).toBe('Hello world');
  });

  it('lets a cumulative status update replace earlier token state', () => {
    expect(
      reduceStreamingUpdates('Hi', [
        { content: ' there', responseStart: 2 },
        { content: 'Authoritative response', replace: true },
        { content: '!', responseStart: 22 },
      ]),
    ).toBe('Authoritative response!');
  });

  it('preserves legacy append-only token streams', () => {
    expect(
      reduceStreamingUpdates('', [{ content: 'book' }, { content: 'keeper' }]),
    ).toBe('bookkeeper');
  });
});
