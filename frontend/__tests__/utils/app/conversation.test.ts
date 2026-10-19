import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
const apiPut = vi.fn();
const apiPost = vi.fn();
const getUserSessionItem = vi.fn();
const setUserSessionItem = vi.fn(() => true);

vi.mock('@/utils/app/api', () => {
  class ConflictError extends Error {
    status = 409;
    code = 'conflict';

    constructor(public serverState: any) {
      super('Conflict: server has newer data');
      this.name = 'ConflictError';
    }
  }

  return {
    apiGet,
    apiPut,
    apiPost,
    ConflictError,
  };
});

vi.mock('@/utils/app/storage', () => ({
  getUserSessionItem,
  setUserSessionItem,
}));

vi.mock('@/utils/app/imageHandler', () => ({
  restoreMessageImages: vi.fn((value) => value),
  cleanMessagesForStorage: vi.fn((value) => value),
  stripBase64Content: vi.fn((value) => value),
}));

describe('saveConversation', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPut.mockReset();
    apiPost.mockReset();
    apiPost.mockResolvedValue({ success: true });
    getUserSessionItem.mockReset();
    setUserSessionItem.mockClear();
  });

  it('persists the merged server state after recovering from a conflict', async () => {
    const { ConflictError } = await import('@/utils/app/api');
    const { saveConversation } = await import('@/utils/app/conversation');

    const serverState = {
      id: 'conv-1',
      name: 'Server conversation',
      updatedAt: 5000,
      messages: [
        { id: 'm1', role: 'user', content: 'Remember my name is Brandon' },
        { id: 'm2', role: 'assistant', content: 'Stored.' },
      ],
    };
    const clientConversation = {
      id: 'conv-1',
      name: 'Client conversation',
      updatedAt: 3000,
      messages: [
        { id: 'm1', role: 'user', content: 'Remember my name is Brandon' },
      ],
    } as any;

    apiPut.mockImplementation(async (url) => {
      if (
        url === '/api/conversations/conv-1' &&
        apiPut.mock.calls.filter(([calledUrl]) => calledUrl === url).length ===
          1
      ) {
        throw new ConflictError(serverState);
      }
      return { success: true };
    });

    await saveConversation(clientConversation);

    const selectedConversationPut = apiPut.mock.calls.find(
      ([url]) => url === '/api/session/selectedConversation',
    );
    expect(selectedConversationPut?.[1]).toMatchObject({
      id: 'conv-1',
      name: 'Server conversation',
      messages: serverState.messages,
    });

    expect(apiPost).toHaveBeenCalledWith(
      '/api/sync/notify',
      expect.objectContaining({
        type: 'conversation_updated',
        conversationId: 'conv-1',
        conversation: expect.objectContaining({
          name: 'Server conversation',
          messages: serverState.messages,
        }),
      }),
    );
  });

  it('persists full history while bounding only the browser selection cache', async () => {
    const { saveConversation } = await import('@/utils/app/conversation');
    const messages = Array.from({ length: 70 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: `message ${index}`,
    }));

    await saveConversation({
      id: 'conv-1',
      name: 'Full history',
      folderId: null,
      updatedAt: 3000,
      messages,
    } as any);

    expect(apiPut).toHaveBeenCalledWith(
      '/api/conversations/conv-1',
      expect.objectContaining({ messages }),
    );
    const selectedCacheCalls = setUserSessionItem.mock.calls as unknown as [
      string,
      string,
    ][];
    const selectedCacheCall = selectedCacheCalls.find(
      ([key]) => key === 'selectedConversation',
    );
    expect(JSON.parse(selectedCacheCall?.[1] ?? '{}')).toEqual(
      expect.objectContaining({ messages: messages.slice(-50) }),
    );
  });

  it('persists server history when browser storage is unavailable', async () => {
    const { saveConversation } = await import('@/utils/app/conversation');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setUserSessionItem.mockImplementationOnce(() => {
      throw new DOMException('Storage disabled', 'SecurityError');
    });
    const conversation = {
      id: 'conv-1',
      messages: [{ role: 'user', content: 'keep this' }],
    } as any;
    try {
      await saveConversation(conversation);
      expect(apiPut).toHaveBeenCalledWith(
        '/api/conversations/conv-1',
        conversation,
      );
      expect(apiPut).toHaveBeenCalledWith(
        '/api/session/selectedConversation',
        conversation,
      );
    } finally {
      warning.mockRestore();
    }
  });

  it('loads complete server history without supplementing it from a browser cache', async () => {
    const { loadConversation } = await import('@/utils/app/conversation');
    // A bounded, stale browser copy of the same conversation must not replace
    // or extend the authoritative server history.
    getUserSessionItem.mockReturnValue(
      JSON.stringify({
        id: 'conv-1',
        messages: [{ id: 'cached', role: 'user', content: 'stale cache' }],
      }),
    );
    const conversation = {
      id: 'conv-1',
      messages: Array.from({ length: 70 }, (_, index) => ({
        id: `m${index}`,
        role: 'user',
        content: `message ${index}`,
      })),
    };
    // Compare with an independent copy: the cleaners return the same object.
    const expected = structuredClone(conversation);
    apiGet.mockResolvedValue(conversation);
    expect(await loadConversation()).toEqual(expected);
  });
});
