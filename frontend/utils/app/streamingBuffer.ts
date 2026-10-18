import { applyStreamingContentDelta } from './streamingContent';

export interface BufferedStreamingUpdate {
  content: string;
  responseStart?: number;
  /** Cumulative status responses replace earlier deltas in the same batch. */
  replace?: boolean;
}

/**
 * A cumulative status snapshot is a repair channel, not an authority.
 *
 * Tokens arrive per-token over the chat pub/sub channel, while `partialResponse`
 * is a server snapshot flushed at most every STREAM_STATUS_FLUSH_INTERVAL_MS and
 * delivered over a different channel. A snapshot that lands after newer tokens
 * would otherwise rewind the visible answer, and the next token — carrying a
 * `responseStart` beyond the rewound length — is then dropped by
 * applyStreamingContentDelta until the following snapshot arrives.
 *
 * Skip a replacement that is a strict prefix of what is already rendered. That
 * is exactly the stale-snapshot case. A snapshot whose content genuinely
 * diverges (for example after the server strips a replayed assistant prefix)
 * still wins, so the sanitized text is not discarded.
 */
export function isStaleCumulativeSnapshot(
  currentContent: string,
  snapshot: string,
): boolean {
  if (snapshot.length >= currentContent.length) return false;
  return currentContent.startsWith(snapshot);
}

export interface OffsetDelta {
  content: string;
  responseStart: number;
}

/**
 * Apply held-back deltas that a repaired response now reaches.
 *
 * One worker publishes a job's tokens in order, so a delta whose offset lies
 * beyond the received text means earlier deltas were lost (for example during
 * a reconnect). Such deltas are held until a cumulative snapshot fills the
 * hole, then applied by offset. Deltas still beyond the end stay pending; ones
 * already covered by the snapshot are dropped.
 */
export function drainOffsetDeltas<T extends OffsetDelta>(
  text: string,
  pending: T[],
): { text: string; pending: T[] } {
  let result = text;
  const remaining: T[] = [];
  for (const delta of [...pending].sort(
    (left, right) => left.responseStart - right.responseStart,
  )) {
    if (delta.responseStart > result.length) {
      remaining.push(delta);
      continue;
    }
    result = applyStreamingContentDelta(
      result,
      delta.content,
      delta.responseStart,
    );
  }
  return { text: result, pending: remaining };
}

export function reduceStreamingUpdates(
  currentContent: string,
  updates: BufferedStreamingUpdate[],
): string {
  return updates.reduce((content, update) => {
    if (update.replace) {
      return isStaleCumulativeSnapshot(content, update.content)
        ? content
        : update.content;
    }
    return applyStreamingContentDelta(
      content,
      update.content,
      update.responseStart,
    );
  }, currentContent);
}
