import { useConversationStore } from '@/state/conversationStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('conversationStore history reconciliation', () => {
  beforeEach(() => {
    useConversationStore.getState().reset();
  });

  it('keeps the selected local draft when a server refresh returns no history', () => {
    const draft = {
      id: 'local-draft',
      name: 'New Conversation',
      messages: [],
      folderId: null,
      updatedAt: 1,
    };
    const store = useConversationStore.getState();
    store.addConversation(draft);
    store.selectConversation(draft.id);

    store.setConversations([]);

    expect(useConversationStore.getState().selectedConversationId).toBe(
      draft.id,
    );
    expect(useConversationStore.getState().conversations).toContainEqual(draft);
  });
});
