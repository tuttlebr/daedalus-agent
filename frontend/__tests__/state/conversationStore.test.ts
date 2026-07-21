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

  it('upserts a conversation instead of adding the same id twice', () => {
    const store = useConversationStore.getState();
    store.addConversation({
      id: 'conv-1',
      name: 'Initial name',
      messages: [],
      folderId: null,
      updatedAt: 1,
    });
    store.addConversation({
      id: 'conv-1',
      name: 'Updated name',
      messages: [],
      folderId: null,
      updatedAt: 2,
    });

    expect(useConversationStore.getState().conversations).toHaveLength(1);
    expect(useConversationStore.getState().conversations[0].name).toBe(
      'Updated name',
    );
  });

  it('deduplicates repeated ids during history reconciliation', () => {
    const store = useConversationStore.getState();
    store.setConversations([
      {
        id: 'conv-1',
        name: 'Older copy',
        messages: [],
        folderId: null,
        updatedAt: 1,
      },
      {
        id: 'conv-1',
        name: 'Newer copy',
        messages: [{ role: 'user', content: 'Hello' }],
        folderId: null,
        updatedAt: 2,
      },
    ]);

    expect(useConversationStore.getState().conversations).toHaveLength(1);
    expect(useConversationStore.getState().conversations[0].name).toBe(
      'Newer copy',
    );
  });
});
