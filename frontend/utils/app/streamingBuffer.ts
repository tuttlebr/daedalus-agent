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
