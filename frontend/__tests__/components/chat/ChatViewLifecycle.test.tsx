/**
 * ChatView with the real useAsyncChat hook and conversation persistence.
 * Only the network, the socket and the presentational children are replaced.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ChatView } from '@/components/chat/ChatView';

import { useConversationStore } from '@/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: any) => void>>();
  return {
    handlers,
    input: null as null | {
      onSend: (message: any) => Promise<void>;
      onStop: () => Promise<void>;
    },
    fetchWithTimeout: vi.fn(),
    apiGet: vi.fn(),
    apiPut: vi.fn(),
    apiPost: vi.fn(),
    manager: {
      isConnected: true,
      subscribeToJob: vi.fn(),
      unsubscribeFromJob: vi.fn(),
      subscribeToChat: vi.fn(),
      unsubscribeFromChat: vi.fn(),
      steerJob: vi.fn(),
      on: vi.fn((type: string, handler: (data: any) => void) => {
        const set = handlers.get(type) || new Set<(data: any) => void>();
        set.add(handler);
        handlers.set(type, set);
        return () => set.delete(handler);
      }),
    },
  };
});

vi.mock('@/services/websocket', () => ({
  getWebSocketManager: vi.fn(() => mocks.manager),
}));
vi.mock('@/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
  FetchTimeoutError: class FetchTimeoutError extends Error {},
}));
vi.mock('@/utils/logger', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));
vi.mock('@/components/auth', () => ({
  useAuth: () => ({ user: { username: 'alice' } }),
}));
vi.mock('@/utils/app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/app/api')>()),
  apiGet: mocks.apiGet,
  apiPut: mocks.apiPut,
  apiPost: mocks.apiPost,
}));
vi.mock('@/components/chat/ChatInput', () => ({
  ChatInput: ({ onSend, onStop }: any) => {
    mocks.input = { onSend, onStop };
    return null;
  },
}));
vi.mock('@/components/chat/MessageBubble', () => ({
  MessageBubble: () => null,
}));

function response(body: any) {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(body) };
}

function emit(type: string, data: any) {
  Array.from(mocks.handlers.get(type) || []).forEach((handler) =>
    handler(data),
  );
}

const step = (uuid: string) => ({
  jobId: 'job-1',
  conversationId: 'conv-1',
  step: { payload: { UUID: uuid, event_type: 'TOOL_START', name: uuid } },
});

const conversationPuts = (id = 'conv-1') =>
  mocks.apiPut.mock.calls.filter(
    ([path]) => path === `/api/conversations/${id}`,
  );
const selectionWrites = () =>
  mocks.apiPut.mock.calls.filter(
    ([path]) => path === '/api/session/selectedConversation',
  );
const messagesOf = (id: string) =>
  useConversationStore.getState().conversations.find((c) => c.id === id)!
    .messages;

let root: Root;

async function send(content = 'hi') {
  await act(async () => {
    await mocks.input!.onSend({ role: 'user', content, metadata: {} });
  });
}

describe('ChatView with the real job lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.input = null;
    localStorage.clear();
    sessionStorage.clear();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(Element.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    mocks.fetchWithTimeout.mockImplementation(async (url: string) =>
      url === '/api/chat/async'
        ? response({ jobId: 'job-1', status: 'pending' })
        : response({
            jobId: 'job-1',
            status: 'pending',
            conversationId: 'conv-1',
            createdAt: 1,
            updatedAt: 1,
          }),
    );
    mocks.apiPut.mockResolvedValue({ success: true, revision: 'saved' });
    mocks.apiPost.mockResolvedValue({ success: true });
    useConversationStore.setState({
      conversations: [],
      selectedConversationId: null,
      streamingConversationIds: new Set(),
    });
    const store = useConversationStore.getState();
    store.addConversation({
      id: 'conv-1',
      name: 'One',
      folderId: null,
      messages: [],
      revision: 'r1',
    } as any);
    store.addConversation({
      id: 'conv-2',
      name: 'Two',
      folderId: null,
      messages: [],
    });
    store.selectConversation('conv-1');
    root = createRoot(document.body.appendChild(document.createElement('div')));
    act(() => root.render(<ChatView />));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('keeps earlier tool steps after a status push without steps, through Stop', async () => {
    await send();
    await act(async () => {
      emit('chat_intermediate_step', step('a'));
      emit('chat_intermediate_step', step('b'));
      // The stored status record an OAuth callback publishes has no steps.
      emit('job_status', {
        jobId: 'job-1',
        status: 'streaming',
        conversationId: 'conv-1',
        createdAt: 1,
        updatedAt: 3,
      });
      emit('chat_intermediate_step', step('c'));
      await vi.advanceTimersByTimeAsync(500);
    });
    const uuids = (steps: any[] = []) =>
      steps.map((item: any) => item.payload.UUID);
    expect(uuids(messagesOf('conv-1')[1].intermediateSteps)).toEqual([
      'a',
      'b',
      'c',
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ success: true, canceled: true })),
    );
    mocks.apiPut.mockClear();
    await act(async () => {
      await mocks.input!.onStop();
      await vi.advanceTimersByTimeAsync(0);
    });
    // Stop saves the turn with every step it had.
    const [[, saved]] = conversationPuts();
    expect(saved.messages[1].metadata).toMatchObject({ stopped: true });
    expect(uuids(saved.messages[1].intermediateSteps)).toEqual(['a', 'b', 'c']);
  });

  it('saves the turn only after the chat request is accepted', async () => {
    let accept!: () => void;
    mocks.fetchWithTimeout.mockImplementation((url: string) =>
      url === '/api/chat/async'
        ? new Promise((resolve) => {
            accept = () =>
              resolve(response({ jobId: 'job-1', status: 'pending' }));
          })
        : Promise.resolve(
            response({
              jobId: 'job-1',
              status: 'pending',
              conversationId: 'conv-1',
              createdAt: 1,
              updatedAt: 1,
            }),
          ),
    );
    let sending!: Promise<void>;
    await act(async () => {
      sending = mocks.input!.onSend({
        role: 'user',
        content: 'hello',
        metadata: {},
      });
      await vi.advanceTimersByTimeAsync(0);
    });
    // The chat request goes out alone: no conversation upload competes.
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      '/api/chat/async',
      expect.objectContaining({ method: 'POST' }),
      expect.any(Number),
    );
    expect(conversationPuts()).toHaveLength(0);

    await act(async () => {
      accept();
      await sending;
    });
    const [[, saved]] = conversationPuts();
    expect(saved.baseRevision).toBe('r1');
    expect(saved.name).toBe('hello');
    expect(saved.messages.map((message: any) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(selectionWrites()).toHaveLength(0);
  });

  it('saves a rejected turn once, with its question and error', async () => {
    mocks.fetchWithTimeout.mockImplementation(async () => ({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: vi.fn().mockResolvedValue({
        error: 'Another response is already active for this conversation.',
      }),
    }));
    await send('still mine');

    const puts = conversationPuts();
    expect(puts).toHaveLength(1);
    const [[, saved]] = puts;
    expect(saved.messages[0]).toMatchObject({
      role: 'user',
      content: 'still mine',
    });
    expect(saved.messages[1].errorMessages.message).toContain('already active');
    expect(
      useConversationStore.getState().streamingConversationIds.has('conv-1'),
    ).toBe(false);
  });

  it('does not upload a turn the worker already saved', async () => {
    await send();
    const assistantId = messagesOf('conv-1')[1].id;
    expect(conversationPuts()).toHaveLength(1); // the accepted turn
    await act(async () => {
      emit('job_status', {
        jobId: 'job-1',
        status: 'completed',
        conversationId: 'conv-1',
        fullResponse: 'done',
        assistantMessageId: assistantId,
        finalizedAt: 5,
        createdAt: 1,
        updatedAt: 5,
      });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(messagesOf('conv-1')[1].content).toBe('done');
    expect(conversationPuts()).toHaveLength(1);
    expect(
      useConversationStore.getState().streamingConversationIds.has('conv-1'),
    ).toBe(false);
  });

  it('saves a background outcome the worker did not save without selecting it', async () => {
    await send();
    const assistantId = messagesOf('conv-1')[1].id;
    // The user moves on while conv-1 still runs.
    act(() => useConversationStore.getState().selectConversation('conv-2'));
    mocks.apiPut.mockClear();
    // The status record expired and no saved answer exists: only this
    // browser holds the turn's outcome.
    mocks.fetchWithTimeout.mockImplementation(async (url: string) =>
      url === '/api/chat/async?jobId=job-1'
        ? { ok: false, status: 404, json: vi.fn(), body: { cancel: vi.fn() } }
        : response({ messages: [] }),
    );
    await act(async () => {
      emit('connected', {});
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(messagesOf('conv-1')[1]).toMatchObject({
      id: assistantId,
      errorMessages: expect.objectContaining({ message: expect.any(String) }),
    });
    expect(conversationPuts()).toHaveLength(1);
    // Saving conv-1 never makes it what a reload opens.
    expect(selectionWrites()).toHaveLength(0);
    expect(sessionStorage.length).toBe(0);
    expect(useConversationStore.getState().selectedConversationId).toBe(
      'conv-2',
    );
  });

  it('sends to a new conversation when the selected one no longer exists', async () => {
    act(() =>
      useConversationStore.getState().selectConversation('conv-deleted'),
    );
    await send('keep this message');

    const state = useConversationStore.getState();
    const selected = state.conversations.find(
      (conversation) => conversation.id === state.selectedConversationId,
    );
    expect(selected?.id).not.toBe('conv-deleted');
    expect(selected?.messages[0]).toMatchObject({
      role: 'user',
      content: 'keep this message',
    });
    const [, request] = mocks.fetchWithTimeout.mock.calls.find(
      ([url]) => url === '/api/chat/async',
    )!;
    expect(JSON.parse(request.body)).toMatchObject({
      conversationId: selected!.id,
    });
    // The new conversation is the user's selection from now on.
    expect(selectionWrites().map(([, body]) => body)).toEqual([
      { id: selected!.id },
    ]);
  });
});
