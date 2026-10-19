import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
const apiPut = vi.fn();
const apiPost = vi.fn();
const getUserSessionItem = vi.fn();
const setUserSessionItem = vi.fn((..._args: [string, string]) => true);

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

// conversation.ts keeps per-module save and selection state.
async function load() {
  const conversation = await import('@/utils/app/conversation');
  const { ConflictError } = await import('@/utils/app/api');
  const { useConversationStore } = await import('@/state/conversationStore');
  return { ...conversation, ConflictError, useConversationStore };
}

const conversationPuts = () =>
  apiPut.mock.calls.filter(([url]) => url === '/api/conversations/conv-1');

describe('saveConversation', () => {
  beforeEach(() => {
    vi.resetModules();
    apiGet.mockReset();
    apiPut.mockReset();
    apiPost.mockReset();
    apiPost.mockResolvedValue({ success: true });
    getUserSessionItem.mockReset();
    setUserSessionItem.mockClear();
  });

  it('sends the revision its copy came from and records the committed one', async () => {
    const { saveConversation, useConversationStore } = await load();
    const copy = {
      id: 'conv-1',
      name: 'Saved',
      folderId: null,
      revision: 'r1',
      messages: [{ id: 'm1', role: 'user', content: 'hello' }],
    } as any;
    useConversationStore.getState().addConversation(copy);
    apiPut.mockResolvedValue({ success: true, revision: 'r2', updatedAt: 9 });

    await expect(saveConversation(copy)).resolves.toMatchObject({
      revision: 'r2',
    });

    const [[, body]] = conversationPuts();
    // The token is the server's; the browser's clock is never compared.
    expect(body).toMatchObject({ baseRevision: 'r1', name: 'Saved' });
    expect(body).not.toHaveProperty('revision');
    expect(
      (useConversationStore.getState().conversations[0] as any).revision,
    ).toBe('r2');
  });

  it('notifies other sessions with only the conversation id and revision', async () => {
    const { saveConversation } = await load();
    apiPut.mockResolvedValue({ success: true, revision: 'r2' });

    await saveConversation({
      id: 'conv-1',
      name: 'Large',
      folderId: null,
      messages: Array.from({ length: 70 }, (_, index) => ({
        id: `m${index}`,
        role: 'user',
        content: `message ${index}`,
      })),
    } as any);

    // The full history is uploaded once, to the conversation record.
    expect(conversationPuts()).toHaveLength(1);
    expect(conversationPuts()[0][1].messages).toHaveLength(70);
    expect(apiPost).toHaveBeenCalledExactlyOnceWith('/api/sync/notify', {
      type: 'conversation_updated',
      conversationId: 'conv-1',
      revision: 'r2',
    });
    // Saving never changes which conversation a reload opens.
    expect(apiPut).not.toHaveBeenCalledWith(
      '/api/session/selectedConversation',
      expect.anything(),
    );
    expect(setUserSessionItem).not.toHaveBeenCalled();
  });

  it("re-applies a rename to another device's newer copy instead of reverting it", async () => {
    const { saveConversation, ConflictError } = await load();
    const serverState = {
      id: 'conv-1',
      name: 'Original',
      folderId: null,
      revision: 'other-device',
      messages: [
        { id: 'm1', role: 'user', content: 'first' },
        { id: 'm2', role: 'assistant', content: 'Answered elsewhere.' },
      ],
    };
    apiPut
      .mockRejectedValueOnce(new ConflictError(serverState))
      .mockResolvedValueOnce({ success: true, revision: 'r3' });

    await saveConversation(
      {
        id: 'conv-1',
        name: 'Renamed',
        folderId: null,
        revision: 'r1',
        messages: [{ id: 'm1', role: 'user', content: 'first' }],
      } as any,
      { fields: ['name'] },
    );

    expect(conversationPuts()[1][1]).toEqual({
      ...serverState,
      revision: undefined,
      name: 'Renamed',
      baseRevision: 'other-device',
    });
  });

  it('appends its turn to a newer copy without replacing a finalized answer', async () => {
    const { saveConversation, ConflictError } = await load();
    const finalized = {
      id: 'a1',
      role: 'assistant',
      content: 'The finished answer.',
      metadata: { jobId: 'job-1', finalizationId: 'fin-1' },
    };
    apiPut
      .mockRejectedValueOnce(
        new ConflictError({
          id: 'conv-1',
          name: 'Chat',
          folderId: null,
          updatedAt: 50,
          messages: [
            { id: 'u1', role: 'user', content: 'question' },
            finalized,
          ],
        }),
      )
      .mockResolvedValueOnce({ success: true, revision: 'r3' });

    // A stale copy: its placeholder for a1 predates the worker's answer, and
    // it holds a new turn the server does not have yet.
    await saveConversation({
      id: 'conv-1',
      name: 'Chat',
      folderId: null,
      revision: 'r1',
      messages: [
        { id: 'u1', role: 'user', content: 'question' },
        { id: 'a1', role: 'assistant', content: '' },
        { id: 'u2', role: 'user', content: 'follow-up' },
        { id: 'a2', role: 'assistant', content: '' },
      ],
    } as any);

    const merged = conversationPuts()[1][1];
    expect(merged.baseRevision).toBe('t50');
    expect(merged.messages.map((message: any) => message.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ]);
    expect(merged.messages[1]).toEqual(finalized);
  });

  it('adds its own flags to a finalized answer it updated, keeping the content', async () => {
    const { saveConversation, ConflictError } = await load();
    apiPut
      .mockRejectedValueOnce(
        new ConflictError({
          id: 'conv-1',
          name: 'Chat',
          folderId: null,
          revision: 'worker',
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              content: 'Partial answer, saved by the worker.',
              metadata: { finalizationId: 'fin-1' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce({ success: true, revision: 'r3' });

    await saveConversation(
      {
        id: 'conv-1',
        name: 'Chat',
        folderId: null,
        revision: 'r1',
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: 'Partial',
            metadata: { stopped: true },
          },
        ],
      } as any,
      { updatedMessageIds: ['a1'] },
    );

    expect(conversationPuts()[1][1].messages).toEqual([
      {
        id: 'a1',
        role: 'assistant',
        content: 'Partial answer, saved by the worker.',
        metadata: { stopped: true, finalizationId: 'fin-1' },
      },
    ]);
  });

  it('bases a save queued behind another on the revision that one committed', async () => {
    const { saveConversation } = await load();
    let commitFirst!: (value: any) => void;
    apiPut
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            commitFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ success: true, revision: 'r3' });
    const copy = (name: string) =>
      ({
        id: 'conv-1',
        name,
        folderId: null,
        revision: 'r1',
        messages: [],
      } as any);

    const first = saveConversation(copy('First'));
    const second = saveConversation(copy('Second'));
    await vi.waitFor(() => expect(conversationPuts()).toHaveLength(1));
    commitFirst({ success: true, revision: 'r2' });
    await Promise.all([first, second]);

    expect(conversationPuts().map(([, body]) => body.baseRevision)).toEqual([
      'r1',
      'r2',
    ]);
  });
});

describe('selected conversation pointer', () => {
  beforeEach(() => {
    vi.resetModules();
    apiGet.mockReset();
    apiPut.mockReset();
    apiPut.mockResolvedValue(undefined);
    getUserSessionItem.mockReset();
    setUserSessionItem.mockClear();
  });

  it('persists a selection as an id, once per change', async () => {
    const { persistSelectedConversation } = await load();

    await persistSelectedConversation('conv-2');
    await persistSelectedConversation('conv-2');

    expect(apiPut.mock.calls).toEqual([
      ['/api/session/selectedConversation', { id: 'conv-2' }],
    ]);
    expect(setUserSessionItem).toHaveBeenLastCalledWith(
      'selectedConversation',
      JSON.stringify({ id: 'conv-2' }),
    );
  });

  it('reads only the id from a stored pointer or an older full copy', async () => {
    const {
      cachedSelectedConversationId,
      loadSelectedConversationId,
      persistSelectedConversation,
    } = await load();
    apiGet.mockResolvedValueOnce({
      id: 'conv-1',
      messages: [{ id: 'm1', role: 'user', content: 'older copy' }],
    });
    expect(await loadSelectedConversationId()).toBe('conv-1');
    // The server already names it.
    await persistSelectedConversation('conv-1');
    expect(apiPut).not.toHaveBeenCalled();

    apiGet.mockResolvedValueOnce(null);
    expect(await loadSelectedConversationId()).toBeNull();
    apiGet.mockRejectedValueOnce(new Error('offline'));
    expect(await loadSelectedConversationId()).toBeUndefined();

    getUserSessionItem.mockReturnValue(
      JSON.stringify({ id: 'cached', name: 'Legacy copy', messages: [] }),
    );
    expect(cachedSelectedConversationId()).toBe('cached');
    getUserSessionItem.mockReturnValue('not json');
    expect(cachedSelectedConversationId()).toBeNull();
  });
});
