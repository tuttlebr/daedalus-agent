import { applyStreamingContentDelta } from './streamingContent';

export interface BufferedStreamingUpdate {
  content: string;
  responseStart?: number;
  /** Cumulative status responses replace earlier deltas in the same batch. */
  replace?: boolean;
}

export function reduceStreamingUpdates(
  currentContent: string,
  updates: BufferedStreamingUpdate[],
): string {
  return updates.reduce((content, update) => {
    if (update.replace) return update.content;
    return applyStreamingContentDelta(
      content,
      update.content,
      update.responseStart,
    );
  }, currentContent);
}
