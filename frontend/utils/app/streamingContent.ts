/**
 * Apply one server-authored response delta without guessing at overlapping
 * characters. `responseStart` is the UTF-16 offset of the delta in the
 * canonical response assembled by the stream worker.
 *
 * Status updates contain the cumulative response and can race with token
 * events over separate Redis/WebSocket channels. The offset makes an older
 * token a harmless no-op while preserving legitimate repeated characters at
 * adjacent token boundaries.
 */
export function applyStreamingContentDelta(
  currentContent: string,
  delta: string,
  responseStart?: number,
): string {
  if (!delta) return currentContent;

  if (
    responseStart === undefined ||
    !Number.isSafeInteger(responseStart) ||
    responseStart < 0
  ) {
    return `${currentContent}${delta}`;
  }

  if (responseStart > currentContent.length) {
    // A token arrived before an earlier token. The next cumulative status
    // update will fill the gap; appending here would corrupt the response.
    return currentContent;
  }

  const responseEnd = responseStart + delta.length;
  const existing = currentContent.slice(responseStart, responseEnd);
  if (existing === delta) {
    return currentContent;
  }

  if (responseStart === currentContent.length) {
    return `${currentContent}${delta}`;
  }

  if (responseEnd > currentContent.length) {
    const existingPrefix = currentContent.slice(responseStart);
    if (delta.startsWith(existingPrefix)) {
      return `${currentContent}${delta.slice(existingPrefix.length)}`;
    }
  }

  // A cumulative status update already supplied different content at this
  // offset. Keep that authoritative value instead of splicing stale data.
  return currentContent;
}
