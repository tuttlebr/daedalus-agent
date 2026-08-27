import {
  isStaleCumulativeSnapshot,
  reduceStreamingUpdates,
} from '@/utils/app/streamingBuffer';

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

  it('ignores a cumulative snapshot that lags the accumulated tokens', () => {
    // The snapshot travels on a different channel than the token stream and is
    // flushed at most every STREAM_STATUS_FLUSH_INTERVAL_MS, so it can arrive
    // behind. Applying it would rewind the visible answer, and the next token's
    // responseStart would then land past the end and be dropped.
    expect(
      reduceStreamingUpdates('The quick brown fox', [
        { content: 'The quick', replace: true },
      ]),
    ).toBe('The quick brown fox');
  });

  it('still applies a shorter snapshot whose content diverges', () => {
    // Server-side sanitization can legitimately shorten the response, e.g. when
    // a replayed assistant prefix is stripped. That is not a stale prefix.
    expect(
      reduceStreamingUpdates('Previous answer. Real answer.', [
        { content: 'Real answer.', replace: true },
      ]),
    ).toBe('Real answer.');
  });

  it('keeps a stale snapshot from stalling the tokens that follow it', () => {
    expect(
      reduceStreamingUpdates('Hello wor', [
        { content: 'Hello', replace: true },
        { content: 'ld', responseStart: 9 },
      ]),
    ).toBe('Hello world');
  });

  describe('isStaleCumulativeSnapshot', () => {
    it('flags a strict prefix of the rendered content', () => {
      expect(isStaleCumulativeSnapshot('abcdef', 'abc')).toBe(true);
    });

    it('accepts an equal or longer snapshot', () => {
      expect(isStaleCumulativeSnapshot('abc', 'abc')).toBe(false);
      expect(isStaleCumulativeSnapshot('abc', 'abcdef')).toBe(false);
    });

    it('accepts a shorter snapshot that is not a prefix', () => {
      expect(isStaleCumulativeSnapshot('abcdef', 'xyz')).toBe(false);
    });
  });
});
