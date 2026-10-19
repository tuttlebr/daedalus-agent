import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { appendIntermediateStep } from '@/utils/app/intermediateSteps';

import { ChatView } from '@/components/chat/ChatView';

import { useConversationStore } from '@/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  asyncOptions: null as any,
  apiGet: vi.fn(),
  cancelJob: vi.fn(),
  saveConversation: vi.fn(),
  startAsyncJob: vi.fn(),
  messageRenders: 0,
  inputRenders: 0,
}));

vi.mock('@/hooks/useAsyncChat', () => ({
  useAsyncChat: vi.fn((options: any) => {
    mocks.asyncOptions = options;
    return {
      startAsyncJob: mocks.startAsyncJob,
      cancelJob: mocks.cancelJob,
      jobStatusByConversationId: {},
    };
  }),
}));

vi.mock('@/components/auth', () => ({
  useAuth: () => ({ user: { username: 'alice' } }),
}));

vi.mock('@/utils/app/conversation', () => ({
  saveConversation: mocks.saveConversation,
}));

vi.mock('@/utils/app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/app/api')>()),
  apiGet: mocks.apiGet,
}));

vi.mock('@/components/chat/ChatInput', async () => {
  const { memo } = await import('react');
  // The real ChatInput is memoized; keep that boundary observable here.
  return {
    ChatInput: memo(({ onStop }: any) => {
      mocks.inputRenders += 1;
      return (
        <button data-testid="chat-input" onClick={onStop}>
          Stop response
        </button>
      );
    }),
  };
});

vi.mock('@/components/chat/MessageBubble', () => ({
  MessageBubble: ({ message, isStreaming, activityProgress, onRetry }: any) => {
    mocks.messageRenders += 1;
    return (
      <div data-testid="message">
        {message.content}
        {onRetry && (
          <button data-testid="retry" onClick={onRetry}>
            Retry
          </button>
        )}
        {isStreaming && (
          <div data-testid="heartbeat">
            {activityProgress?.text || 'Thinking...'}
            <span data-testid="activity-categories">
              {(message.intermediateSteps || [])
                .map((step: any) => step.payload.event_type.split('_')[0])
                .join(',')}
            </span>
          </div>
        )}
      </div>
    );
  },
}));

// useAsyncChat reports each live step through onIntermediateStep and then
// through onProgress with the run's reconciled step list.
const runSteps = new Map<string, any[]>();
function deliverStep(
  event: { conversationId: string; assistantMessageId: string; step: any },
  status: Record<string, any> = {},
) {
  const steps = appendIntermediateStep(
    runSteps.get(event.conversationId) ?? [],
    event.step,
  );
  runSteps.set(event.conversationId, steps);
  mocks.asyncOptions.onIntermediateStep(event);
  mocks.asyncOptions.onProgress({
    jobId: `job-${event.conversationId}`,
    status: 'streaming',
    conversationId: event.conversationId,
    assistantMessageId: event.assistantMessageId,
    createdAt: 1,
    updatedAt: 1,
    ...status,
    intermediateSteps: steps,
  });
}

function renderChatView(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<ChatView />);
  });

  return { root, container };
}

describe('ChatView OAuth banner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.saveConversation.mockResolvedValue(undefined);
    runSteps.clear();
    mocks.messageRenders = 0;
    mocks.inputRenders = 0;
    localStorage.clear();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(Element.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(window, 'open').mockImplementation(() => null);

    useConversationStore.setState({
      conversations: [],
      selectedConversationId: null,
      streamingConversationIds: new Set(),
    });
    const store = useConversationStore.getState();
    store.addConversation({
      id: 'conv-1',
      name: 'OAuth test',
      folderId: null,
      messages: [
        { id: 'user-1', role: 'user', content: 'read my email' },
        { id: 'assistant-1', role: 'assistant', content: '' },
      ],
    });
    store.selectConversation('conv-1');
    store.setStreaming('conv-1', true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('keeps activity and completion scoped to each concurrently running conversation', async () => {
    const store = useConversationStore.getState();
    store.addConversation({
      id: 'conv-2',
      name: 'Second running chat',
      folderId: null,
      messages: [
        { id: 'user-2', role: 'user', content: 'different question' },
        { id: 'assistant-2', role: 'assistant', content: '' },
      ],
    });
    store.setStreaming('conv-2', true);
    const { root, container } = renderChatView();
    const categories = () =>
      container.querySelector('[data-testid="activity-categories"]')
        ?.textContent;

    act(() => {
      deliverStep({
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        step: {
          payload: {
            event_type: 'TOOL_START',
            UUID: 'tool-1',
            name: 'research',
          },
        },
      });
    });
    expect(categories()).toBe('TOOL');

    act(() => store.selectConversation('conv-2'));
    expect(categories()).toBe('');
    expect(
      container.querySelector('[data-testid="heartbeat"]')?.textContent,
    ).toBe('Thinking...');
    act(() => {
      deliverStep({
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        step: {
          payload: {
            event_type: 'TOOL_END',
            UUID: 'tool-1',
            data: { output: 'old chat result' },
          },
        },
      });
    });
    expect(categories()).toBe('');
    act(() => {
      deliverStep({
        conversationId: 'conv-2',
        assistantMessageId: 'assistant-2',
        step: { payload: { event_type: 'LLM_START', UUID: 'model-2' } },
      });
    });
    expect(categories()).toBe('LLM');

    act(() => store.selectConversation('conv-1'));
    // The background tool's START and END both reached its own message.
    expect(categories()).toBe('TOOL,TOOL');
    act(() => store.selectConversation('conv-2'));
    act(() =>
      mocks.asyncOptions.onComplete(
        'first chat done',
        [],
        undefined,
        'conv-1',
        { assistantMessageId: 'assistant-1', generationDurationMs: 125000 },
      ),
    );
    expect(categories()).toBe('LLM');
    const conversations = useConversationStore.getState().conversations;
    expect(
      conversations.find((c) => c.id === 'conv-1')?.messages[1]
        .generationDurationMs,
    ).toBe(125000);
    expect(
      conversations.find((c) => c.id === 'conv-2')?.messages[1]
        .generationDurationMs,
    ).toBeUndefined();
    expect(
      useConversationStore.getState().streamingConversationIds.has('conv-2'),
    ).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).not.toBe(
      'Response complete',
    );
    act(() => root.unmount());
  });

  it('keeps both phases of a tool call that shares one UUID during an OAuth wait', async () => {
    const { root } = renderChatView();
    const oauthWait = {
      jobId: 'job-1',
      status: 'oauth_required',
      conversationId: 'conv-1',
      assistantMessageId: 'assistant-1',
      authUrl: 'https://accounts.google.com/auth',
      oauthState: 'pending',
      createdAt: 1,
      updatedAt: 1,
    };
    // The stream worker gives a tool's START and END the same UUID. While an
    // authorization is pending, status progress does not replace the steps.
    const phases = ['TOOL_START', 'TOOL_END'].map((eventType, index) => ({
      parent_id: 'root',
      payload: {
        event_type: eventType,
        event_timestamp: index + 1,
        name: 'sibling_search',
        UUID: 'tool-1',
      },
    }));
    await act(async () => {
      for (const step of phases) {
        deliverStep(
          { conversationId: 'conv-1', assistantMessageId: 'assistant-1', step },
          oauthWait,
        );
      }
    });

    const assistant =
      useConversationStore.getState().conversations[0].messages[1];
    expect(
      assistant.intermediateSteps?.map((step) => step.payload.event_type),
    ).toEqual(['TOOL_START', 'TOOL_END']);
    act(() => root.unmount());
  });

  it('stops the response of a conversation deleted while it streams', async () => {
    mocks.cancelJob.mockResolvedValue(undefined);
    const { root } = renderChatView();
    await act(async () => {
      useConversationStore.getState().deleteConversation('conv-1');
    });
    expect(mocks.cancelJob).toHaveBeenCalledExactlyOnceWith('conv-1');

    // Its remaining live events cannot mark the deleted chat as streaming,
    // which would suppress conversation list refreshes until the job ended.
    await act(async () => {
      mocks.asyncOptions.onIntermediateStep({
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        step: { payload: { event_type: 'TOOL_START', UUID: 'tool-1' } },
      });
    });
    expect(
      useConversationStore.getState().streamingConversationIds.has('conv-1'),
    ).toBe(false);
    act(() => root.unmount());
  });

  it("keeps a background conversation's authorization prompt across switches", async () => {
    const store = useConversationStore.getState();
    store.addConversation({
      id: 'conv-2',
      name: 'Other chat',
      folderId: null,
      messages: [],
    });
    const { root } = renderChatView();
    await act(async () => {
      mocks.asyncOptions.onProgress({
        jobId: 'job-1',
        status: 'oauth_required',
        conversationId: 'conv-1',
        authUrl: 'https://accounts.google.com/auth?scope=gmail.readonly',
        oauthState: 'gmail-state',
        createdAt: 1,
        updatedAt: 1,
      });
    });
    expect(document.body.textContent).toContain('Connect Gmail');

    act(() => store.selectConversation('conv-2'));
    expect(document.body.textContent).not.toContain('Connect Gmail');
    // The job still waits for this authorization; its status is not re-sent.
    act(() => store.selectConversation('conv-1'));
    expect(document.body.textContent).toContain('Connect Gmail');
    act(() => root.unmount());
  });

  it('retries the prompt rather than a direction sent while it ran', async () => {
    const store = useConversationStore.getState();
    store.setStreaming('conv-1', false);
    store.updateConversation('conv-1', {
      messages: [
        { id: 'user-1', role: 'user', content: 'read my email' },
        {
          id: 'direction-1',
          role: 'user',
          content: 'only unread ones',
          metadata: { steeringCommandId: 'direction-1', jobId: 'job-1' },
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          errorMessages: {
            message: 'Connection lost.',
            category: 'network',
            recoverable: true,
            timestamp: 1,
          },
        },
      ],
    });
    mocks.startAsyncJob.mockResolvedValue('job-2');
    const { root } = renderChatView();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')!
        .click();
    });

    const [messages] = mocks.startAsyncJob.mock.calls[0];
    expect(messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'read my email',
    });
    act(() => root.unmount());
  });

  it('saves text that arrived while Stop was being confirmed', async () => {
    let confirmStop!: () => void;
    mocks.cancelJob.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirmStop = resolve;
        }),
    );
    const { root, container } = renderChatView();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-input"]')!
        .click();
    });
    await act(async () => {
      mocks.asyncOptions.onToken({
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        content: 'Last words.',
        responseStart: 0,
      });
      confirmStop();
    });

    const saved = mocks.saveConversation.mock.calls.at(-1)![0];
    expect(saved.messages[1]).toMatchObject({
      content: 'Last words.',
      metadata: { stopped: true },
    });
    act(() => root.unmount());
  });

  it('persists an explicit stopped outcome on the correct assistant message', async () => {
    const { root, container } = renderChatView();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-input"]')!
        .click(),
    );
    expect(mocks.cancelJob).toHaveBeenCalledWith('conv-1');
    const conversation = useConversationStore
      .getState()
      .conversations.find((c) => c.id === 'conv-1')!;
    expect(conversation.messages[1].metadata?.stopped).toBe(true);
    expect(
      useConversationStore.getState().streamingConversationIds.has('conv-1'),
    ).toBe(false);
    act(() => root.unmount());
  });

  it('keeps buffered assistant text and tool evidence when an error has no snapshot', async () => {
    const { root } = renderChatView();
    const step = {
      payload: {
        event_type: 'TOOL_END',
        UUID: 'research-1',
        data: { output: 'Useful research evidence' },
      },
    };
    await act(async () => {
      deliverStep({
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        step,
      });
      mocks.asyncOptions.onToken({
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        content: 'Useful answer still in the UI buffer.',
        responseStart: 0,
      });
      mocks.asyncOptions.onError('Connection interrupted', {
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
      });
    });

    const assistant =
      useConversationStore.getState().conversations[0].messages[1];
    expect(assistant.content).toBe('Useful answer still in the UI buffer.');
    expect(assistant.intermediateSteps).toEqual([step]);
    expect(assistant.errorMessages?.message).toContain('Connection lost');
    act(() => root.unmount());
  });

  it('keeps newer text and steps when terminal error snapshots lag behind live events', async () => {
    const { root } = renderChatView();
    const steps = ['first', 'second'].map((id) => ({
      payload: {
        event_type: 'TOOL_END',
        UUID: id,
        data: { output: `${id} finding` },
      },
    }));
    await act(async () => {
      for (const step of steps) {
        deliverStep({
          conversationId: 'conv-1',
          assistantMessageId: 'assistant-1',
          step,
        });
      }
      mocks.asyncOptions.onToken({
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        content: 'First finding. Second newer finding.',
        responseStart: 0,
      });
      mocks.asyncOptions.onProgress({
        status: 'error',
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        partialResponse: 'First finding.',
        intermediateSteps: steps.slice(0, 1),
        error: 'Backend disconnected',
      });
      mocks.asyncOptions.onError('Backend disconnected', {
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        partialResponse: 'First finding.',
        intermediateSteps: steps.slice(0, 1),
      });
    });

    const assistant =
      useConversationStore.getState().conversations[0].messages[1];
    expect(assistant.content).toBe('First finding. Second newer finding.');
    expect(assistant.intermediateSteps).toEqual(steps);
    act(() => root.unmount());
  });

  it.each([0, 3000])(
    'keeps OAuth prompts through streaming and accepts a fresh challenge after %i ms',
    async (delay) => {
      const { root } = renderChatView();

      await act(async () => {
        mocks.asyncOptions.onProgress({
          jobId: 'job-1',
          status: 'oauth_required',
          conversationId: 'conv-1',
          authUrl: 'https://accounts.google.com/auth?scope=gmail.readonly',
          oauthState: 'gmail-state',
          createdAt: 1,
          updatedAt: 1,
        });
      });

      expect(document.body.textContent).toContain(
        'Google authorization required',
      );
      expect(document.body.textContent).toContain('Connect Gmail');

      await act(async () => {
        mocks.asyncOptions.onProgress({
          jobId: 'job-1',
          status: 'streaming',
          conversationId: 'conv-1',
          partialResponse: 'Still working.',
          createdAt: 1,
          updatedAt: 2,
        });
      });

      expect(document.body.textContent).toContain('Connect Gmail');

      const button = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.includes('Connect Gmail'),
      );
      expect(button).toBeDefined();

      await act(async () => {
        button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(window.open).toHaveBeenCalledWith(
        'https://accounts.google.com/auth?scope=gmail.readonly',
        '_blank',
        'noopener,noreferrer',
      );
      expect(document.body.textContent).toContain('Reopen Gmail');

      await act(async () => {
        mocks.asyncOptions.onProgress({
          jobId: 'job-1',
          status: 'streaming',
          conversationId: 'conv-1',
          partialResponse: 'Still working.',
          createdAt: 1,
          updatedAt: 3,
        });
      });

      expect(document.body.textContent).toContain(
        'Google authorization connected',
      );
      expect(document.body.textContent).toContain('Gmail connected');

      await act(async () => {
        vi.advanceTimersByTime(delay);
      });

      if (delay) {
        expect(document.body.textContent).not.toContain('Gmail connected');
      }

      // A replay of the challenge already completed remains suppressed.
      await act(async () => {
        mocks.asyncOptions.onProgress({
          jobId: 'job-1',
          status: 'oauth_required',
          conversationId: 'conv-1',
          authUrl: 'https://accounts.google.com/auth?scope=gmail.readonly',
          oauthState: 'gmail-state',
          createdAt: 1,
          updatedAt: 4,
        });
      });
      expect(document.body.textContent).not.toContain('Connect Gmail');

      await act(async () => {
        mocks.asyncOptions.onProgress({
          jobId: 'job-1',
          status: 'oauth_required',
          conversationId: 'conv-1',
          authUrl: 'https://accounts.google.com/auth?scope=gmail.readonly',
          oauthState: 'gmail-state-2',
          createdAt: 1,
          updatedAt: 4,
        });
      });

      expect(document.body.textContent).toContain('Connect Gmail');
      expect(document.body.textContent).not.toContain('Gmail connected');

      act(() => {
        root.unmount();
      });
    },
  );

  it('renders the reconciled response text supplied with live tokens', async () => {
    const { root } = renderChatView();
    // Earlier tokens were lost before this one; the hook has already repaired
    // the text from a status read and supplies the reconciled response.
    await act(async () => {
      mocks.asyncOptions.onToken({
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        content: ' world',
        responseStart: 20,
        partialResponse: 'Hello, missing words world',
      });
      vi.advanceTimersByTime(120);
    });

    expect(
      useConversationStore.getState().conversations[0].messages[1].content,
    ).toBe('Hello, missing words world');
    act(() => root.unmount());
  });

  describe('a job whose assistant message is missing from this copy', () => {
    const previousTurn = [
      { id: 'user-1', role: 'user' as const, content: 'first question' },
      {
        id: 'assistant-1',
        role: 'assistant' as const,
        content: 'Previous answer',
        intermediateSteps: [],
      },
    ];
    const step = {
      payload: { event_type: 'TOOL_START', UUID: 'tool-2', name: 'search' },
    };

    beforeEach(() => {
      // Another tab or device started this turn; this copy predates it.
      useConversationStore.setState({
        conversations: [],
        selectedConversationId: null,
        streamingConversationIds: new Set(),
      });
      const store = useConversationStore.getState();
      store.addConversation({
        id: 'conv-1',
        name: 'Stale copy',
        folderId: null,
        messages: previousTurn,
      });
      store.selectConversation('conv-1');
    });

    function expectPreviousAnswerIntact() {
      const conversation = useConversationStore
        .getState()
        .conversations.find((c) => c.id === 'conv-1')!;
      const previous = conversation.messages.find(
        (message) => message.id === 'assistant-1',
      )!;
      expect(previous.content).toBe('Previous answer');
      expect(previous.intermediateSteps).toEqual([]);
    }

    function expectNoSaveWithoutJobMessage() {
      for (const [saved] of mocks.saveConversation.mock.calls) {
        expect(saved.messages.map((message: any) => message.id)).toContain(
          'assistant-2',
        );
      }
    }

    it('adopts the authoritative conversation instead of rewriting an earlier answer', async () => {
      mocks.apiGet.mockResolvedValue({
        id: 'conv-1',
        name: 'Stale copy',
        folderId: null,
        updatedAt: 10,
        messages: [
          ...previousTurn,
          { id: 'user-2', role: 'user', content: 'second question' },
          {
            id: 'assistant-2',
            role: 'assistant',
            content: '',
            metadata: { turnId: 'turn-2' },
          },
        ],
      });
      const { root } = renderChatView();
      await act(async () => {
        mocks.asyncOptions.onProgress({
          jobId: 'job-2',
          status: 'streaming',
          conversationId: 'conv-1',
          assistantMessageId: 'assistant-2',
          partialResponse: 'New ans',
          intermediateSteps: [step],
          createdAt: 1,
          updatedAt: 2,
        });
        await vi.advanceTimersByTimeAsync(120);
      });
      expectPreviousAnswerIntact();
      expect(mocks.apiGet).toHaveBeenCalledWith('/api/conversations/conv-1');

      await act(async () => {
        mocks.asyncOptions.onComplete(
          'New answer',
          [step],
          Date.now(),
          'conv-1',
          { assistantMessageId: 'assistant-2', jobId: 'job-2' },
        );
      });
      expectPreviousAnswerIntact();
      const conversation = useConversationStore.getState().conversations[0];
      expect(conversation.messages.map((message) => message.id)).toEqual([
        'user-1',
        'assistant-1',
        'user-2',
        'assistant-2',
      ]);
      expect(conversation.messages[3].content).toBe('New answer');
      expect(mocks.saveConversation).toHaveBeenCalled();
      expectNoSaveWithoutJobMessage();
      act(() => root.unmount());
    });

    it('never saves the stale copy when the conversation cannot be reloaded', async () => {
      mocks.apiGet.mockRejectedValue(new Error('offline'));
      const { root } = renderChatView();
      await act(async () => {
        mocks.asyncOptions.onProgress({
          jobId: 'job-2',
          status: 'streaming',
          conversationId: 'conv-1',
          assistantMessageId: 'assistant-2',
          partialResponse: 'New ans',
          intermediateSteps: [step],
          createdAt: 1,
          updatedAt: 2,
        });
        await vi.advanceTimersByTimeAsync(120);
        mocks.asyncOptions.onComplete(
          'New answer',
          [step],
          Date.now(),
          'conv-1',
          { assistantMessageId: 'assistant-2', jobId: 'job-2' },
        );
        await vi.advanceTimersByTimeAsync(0);
      });
      expectPreviousAnswerIntact();
      expectNoSaveWithoutJobMessage();
      expect(
        useConversationStore.getState().streamingConversationIds.has('conv-1'),
      ).toBe(false);
      act(() => root.unmount());
    });
  });

  it('renders the first tokens promptly, then coalesces updates per flush interval', async () => {
    const { root } = renderChatView();
    const token = (content: string, responseStart: number) =>
      mocks.asyncOptions.onToken({
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        content,
        responseStart,
      });

    await act(async () => {
      token('Hello', 0);
      token(' world', 5);
    });
    // Tokens from the same task share one render; after an idle interval it
    // runs on the next task instead of waiting a full flush interval.
    expect(document.body.textContent).not.toContain('Hello');
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    expect(document.body.textContent).toContain('Hello world');

    // STREAM_RENDER_INTERVAL_MS in ChatView: later updates wait for the
    // interval, so one render covers every token received in it.
    await act(async () => {
      vi.advanceTimersByTime(20);
      token('!', 11);
    });
    await act(async () => {
      vi.advanceTimersByTime(99);
    });
    expect(document.body.textContent).not.toContain('Hello world!');
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(document.body.textContent).toContain('Hello world!');

    act(() => root.unmount());
  });

  it.each([
    [
      'completion',
      () =>
        mocks.asyncOptions.onComplete('Approve?', [], Date.now(), 'conv-1', {
          assistantMessageId: 'assistant-1',
          jobId: 'job-1',
        }),
    ],
    [
      'error',
      () =>
        mocks.asyncOptions.onError('Backend disconnected', {
          conversationId: 'conv-1',
          assistantMessageId: 'assistant-1',
          jobId: 'job-1',
          partialResponse: 'Approve?',
        }),
    ],
  ])(
    'keeps the job identity on the answer it finishes (%s)',
    async (_label, finish) => {
      const { root } = renderChatView();
      await act(async () => {
        finish();
      });
      const assistant =
        useConversationStore.getState().conversations[0].messages[1];
      // The worker saves metadata.jobId with the answer; approvals, traces
      // and recovery read it, and this copy is saved over that record.
      expect(assistant.metadata?.jobId).toBe('job-1');
      for (const [saved] of mocks.saveConversation.mock.calls) {
        expect(saved.messages[1].metadata?.jobId).toBe('job-1');
      }
      act(() => root.unmount());
    },
  );

  it.each([
    ['completed', true],
    ['error', true],
    ['error', false],
  ] as const)(
    'finishes a %s turn once when its terminal status precedes the outcome callback (worker saved it: %s)',
    async (outcome, persisted) => {
      const { root } = renderChatView();
      const status = {
        jobId: 'job-1',
        status: outcome,
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        fullResponse: outcome === 'completed' ? 'Done.' : undefined,
        partialResponse: 'Done.',
        error: outcome === 'error' ? 'Backend disconnected' : undefined,
        finalizedAt: persisted ? 2 : undefined,
        createdAt: 1,
        updatedAt: 2,
      };
      // useAsyncChat reports a terminal job_status through onProgress and
      // then, in the same task, through onComplete or onError.
      await act(async () => {
        mocks.asyncOptions.onProgress(status);
        if (outcome === 'completed') {
          mocks.asyncOptions.onComplete('Done.', [], 2, 'conv-1', {
            assistantMessageId: 'assistant-1',
            jobId: 'job-1',
            persisted,
          });
        } else {
          mocks.asyncOptions.onError('Backend disconnected', {
            conversationId: 'conv-1',
            assistantMessageId: 'assistant-1',
            jobId: 'job-1',
            partialResponse: 'Done.',
            generationDurationMs: 4200,
            persisted,
          });
        }
      });

      const assistant =
        useConversationStore.getState().conversations[0].messages[1];
      expect(assistant.content).toBe('Done.');
      expect(Boolean(assistant.errorMessages)).toBe(outcome === 'error');
      expect(assistant.metadata?.jobId).toBe('job-1');
      // The worker already saved its own outcome; uploading the copy again
      // would only repeat it. An outcome it did not save is saved once.
      expect(mocks.saveConversation).toHaveBeenCalledTimes(persisted ? 0 : 1);
      if (!persisted) {
        const [saved, change] = mocks.saveConversation.mock.calls[0];
        expect(saved.messages[1]).toMatchObject({
          content: 'Done.',
          // The worker records the duration of a failed turn too.
          generationDurationMs: 4200,
          metadata: { jobId: 'job-1' },
        });
        expect(change).toEqual({ updatedMessageIds: ['assistant-1'] });
      }
      expect(
        useConversationStore.getState().streamingConversationIds.has('conv-1'),
      ).toBe(false);
      act(() => root.unmount());
    },
  );

  it('does not re-render the conversation for tokens between flushes', async () => {
    const { root } = renderChatView();
    const token = (content: string, responseStart: number) =>
      mocks.asyncOptions.onToken({
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        content,
        responseStart,
      });
    await act(async () => {
      token('Hello', 0);
      vi.advanceTimersByTime(0);
    });
    const rendersAfterFirstFlush = mocks.messageRenders;

    // Each token arrives in its own WebSocket task.
    for (let index = 0; index < 5; index += 1) {
      await act(async () => {
        token('!', 5 + index);
      });
    }
    expect(mocks.messageRenders).toBe(rendersAfterFirstFlush);

    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(document.body.textContent).toContain('Hello!!!!!');
    // Two bubbles (user and assistant) render once for the coalesced flush.
    expect(mocks.messageRenders).toBe(rendersAfterFirstFlush + 2);
    // Streamed text does not change the composer's props.
    expect(mocks.inputRenders).toBe(1);
    act(() => root.unmount());
  });

  it('jumps to the latest message by scrolling only the conversation pane', () => {
    const { root } = renderChatView();
    const scroller = document.querySelector(
      '[aria-label="Conversation messages"]',
    ) as HTMLDivElement;
    Object.defineProperty(scroller, 'scrollHeight', { value: 2400 });
    act(() => {
      scroller.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -40 }),
      );
    });
    const scrollTo = vi.mocked(Element.prototype.scrollTo);
    scrollTo.mockClear();
    const jump = document.querySelector<HTMLButtonElement>(
      '[aria-label="Jump to latest messages"]',
    )!;
    act(() => jump.click());

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: 2400,
      behavior: 'smooth',
    });
    expect(scrollTo.mock.contexts[0]).toBe(scroller);
    act(() => root.unmount());
  });

  it('keeps a paused reading position when streaming completes', async () => {
    const { root } = renderChatView();
    const scrollTo = vi.mocked(Element.prototype.scrollTo);
    const scroller = document.querySelector(
      '[aria-label="Conversation messages"]',
    ) as HTMLDivElement;

    await act(async () => {
      scroller.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -40 }),
      );
    });
    scrollTo.mockClear();

    await act(async () => {
      mocks.asyncOptions.onToken({
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        content: 'Reading stays put.',
        responseStart: 0,
      });
      vi.advanceTimersByTime(50);
      mocks.asyncOptions.onComplete(
        'Reading stays put.',
        [],
        Date.now(),
        'conv-1',
        { assistantMessageId: 'assistant-1' },
      );
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Response complete');

    act(() => root.unmount());
  });
});
