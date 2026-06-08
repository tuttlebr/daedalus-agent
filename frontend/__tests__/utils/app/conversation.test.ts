import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
const apiPut = vi.fn();
const apiPost = vi.fn();
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
  getUserSessionItem: vi.fn(),
  setUserSessionItem,
  removeUserSessionItem: vi.fn(),
}));

vi.mock('@/utils/app/conversationPagination', () => ({
  paginateConversation: vi.fn(async (conversation) => conversation),
  loadConversationMessages: vi.fn(),
  enforceConversationSizeLimit: vi.fn(),
  cleanupOldConversations: vi.fn(async () => 0),
  MESSAGES_IN_MEMORY: 50,
  MAX_CONVERSATION_MESSAGES: 500,
}));

vi.mock('@/utils/app/conversationReplay', () => ({
  sanitizeConversationAssistantReplays: vi.fn((value) => value),
  sanitizeConversationsAssistantReplays: vi.fn((value) => value),
}));

vi.mock('@/utils/app/imageHandler', () => ({
  restoreMessageImages: vi.fn((value) => value),
  cleanMessagesForStorage: vi.fn((value) => value),
  stripBase64Content: vi.fn((value) => value),
}));

vi.mock('@/utils/app/visibilityAwareTimer', () => ({
  createVisibilityAwareInterval: vi.fn(),
}));

describe('saveConversation', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPut.mockReset();
    apiPost.mockReset();
    apiPost.mockResolvedValue({ success: true });
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
});
