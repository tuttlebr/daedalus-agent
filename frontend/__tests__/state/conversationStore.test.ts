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

  it('adopts a newer server copy of the selected conversation', () => {
    const store = useConversationStore.getState();
    store.addConversation({
      id: 'conv-1',
      name: 'Shared chat',
      messages: [{ id: 'user-1', role: 'user', content: 'Hello' }],
      folderId: null,
      updatedAt: 1,
    });
    store.selectConversation('conv-1');

    // Another device continued this chat while this tab missed live sync.
    const server = {
      id: 'conv-1',
      name: 'Shared chat',
      messages: [
        { id: 'user-1', role: 'user' as const, content: 'Hello' },
        { id: 'assistant-1', role: 'assistant' as const, content: 'Hi' },
        { id: 'user-2', role: 'user' as const, content: 'From my phone' },
      ],
      folderId: null,
      updatedAt: 5,
    };
    store.setConversations([server]);

    const selected = useConversationStore
      .getState()
      .conversations.find((c) => c.id === 'conv-1');
    expect(selected?.messages.map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
    ]);
    expect(useConversationStore.getState().selectedConversationId).toBe(
      'conv-1',
    );
  });

  it('keeps newer unsaved local state for the selected conversation', () => {
    const store = useConversationStore.getState();
    const local = {
      id: 'conv-1',
      name: 'Renamed locally',
      messages: [{ id: 'user-1', role: 'user' as const, content: 'Hello' }],
      folderId: null,
      updatedAt: 10,
    };
    store.addConversation(local);
    store.selectConversation('conv-1');

    store.setConversations([
      { ...local, name: 'Older server name', updatedAt: 5 },
    ]);

    expect(useConversationStore.getState().conversations).toEqual([local]);
  });

  it('keeps local copies of streaming conversations during a history refresh', () => {
    const store = useConversationStore.getState();
    const streaming = {
      id: 'conv-streaming',
      name: 'Background answer',
      messages: [
        { id: 'user-1', role: 'user' as const, content: 'Hello' },
        { id: 'assistant-1', role: 'assistant' as const, content: 'Partial' },
      ],
      folderId: null,
      updatedAt: 1,
    };
    const unsaved = {
      id: 'conv-unsaved',
      name: 'First turn still streaming',
      messages: [{ id: 'user-2', role: 'user' as const, content: 'Hi' }],
      folderId: null,
      updatedAt: 1,
    };
    store.addConversation(streaming);
    store.addConversation(unsaved);
    store.setStreaming(streaming.id, true);
    store.setStreaming(unsaved.id, true);

    // The persisted copy predates the in-progress assistant message, and the
    // first turn of the other conversation has not been saved yet.
    store.setConversations([
      { ...streaming, messages: streaming.messages.slice(0, 1), updatedAt: 5 },
    ]);

    const conversations = useConversationStore.getState().conversations;
    expect(conversations).toHaveLength(2);
    expect(conversations).toContainEqual(streaming);
    expect(conversations).toContainEqual(unsaved);
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
