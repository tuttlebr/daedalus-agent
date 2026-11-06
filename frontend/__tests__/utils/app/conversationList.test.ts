import {
  AUTONOMOUS_CONVERSATION_ID,
  mostRecentConversation,
} from '@/utils/app/conversationList';

import { describe, expect, it } from 'vitest';

const conversation = (id: string, updatedAt?: number) =>
  ({ id, name: id, folderId: null, messages: [], updatedAt } as any);

describe('mostRecentConversation', () => {
  it('chooses by update time, not list position', () => {
    expect(
      mostRecentConversation([
        conversation('old', 1),
        conversation('new', 30),
        conversation('undated'),
      ])?.id,
    ).toBe('new');
  });

  it('never chooses the read-only agent log', () => {
    expect(
      mostRecentConversation([conversation(AUTONOMOUS_CONVERSATION_ID, 99)]),
    ).toBeUndefined();
    expect(mostRecentConversation([])).toBeUndefined();
  });
});
