import type { Conversation } from '@/types/chat';

function isMoreComplete(
  candidate: Conversation,
  current: Conversation,
): boolean {
  const candidateUpdatedAt = Number(candidate.updatedAt) || 0;
  const currentUpdatedAt = Number(current.updatedAt) || 0;
  if (candidateUpdatedAt !== currentUpdatedAt) {
    return candidateUpdatedAt > currentUpdatedAt;
  }
  return (candidate.messages?.length || 0) > (current.messages?.length || 0);
}

/**
 * Return at most one conversation for each stable conversation id.
 *
 * Keep the first list position so history ordering remains stable, but replace
 * its value when a later duplicate contains newer or more complete data. The
 * original array reference is retained when no duplicate exists.
 */
export function dedupeConversationsById(
  conversations: Conversation[],
): Conversation[] {
  const result: Conversation[] = [];
  const indexById = new Map<string, number>();
  let changed = false;

  for (const conversation of conversations) {
    const id = typeof conversation?.id === 'string' ? conversation.id : '';
    if (!id) {
      result.push(conversation);
      continue;
    }

    const existingIndex = indexById.get(id);
    if (existingIndex === undefined) {
      indexById.set(id, result.length);
      result.push(conversation);
      continue;
    }

    changed = true;
    if (isMoreComplete(conversation, result[existingIndex])) {
      result[existingIndex] = conversation;
    }
  }

  return changed ? result : conversations;
}
