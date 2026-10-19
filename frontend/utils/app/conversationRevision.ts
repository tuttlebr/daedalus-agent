/**
 * The concurrency token of a stored conversation record, or null when no
 * record exists.
 *
 * Browser saves store a fresh random `revision` with every commit. Records
 * written without one (before revisions existed, by the worker's
 * finalization, or by a chat reservation) are identified by their
 * server-stamped `updatedAt`, which every such writer replaces. Both forms
 * therefore change whenever the record does.
 */
export function conversationRevision(record: unknown): string | null {
  if (!record || typeof record !== 'object') return null;
  const { revision, updatedAt } = record as {
    revision?: unknown;
    updatedAt?: unknown;
  };
  if (typeof revision === 'string' && revision) return revision;
  return `t${Number(updatedAt) || 0}`;
}

/** A stored record as returned to the browser, with its concurrency token. */
export function withConversationRevision<T extends object>(
  record: T,
): T & { revision: string } {
  return { ...record, revision: conversationRevision(record) as string };
}
