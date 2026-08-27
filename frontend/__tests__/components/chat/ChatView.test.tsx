import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ChatView } from '@/components/chat/ChatView';

import { useConversationStore } from '@/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  asyncOptions: null as any,
  cancelJob: vi.fn(),
  startAsyncJob: vi.fn(),
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
  saveConversation: vi.fn(),
}));

vi.mock('@/components/chat/AgentHeartbeat', () => ({
  AgentHeartbeat: () => <div data-testid="heartbeat" />,
}));

vi.mock('@/components/chat/ChatInput', () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock('@/components/chat/MessageBubble', () => ({
  MessageBubble: ({ message }: any) => (
    <div data-testid="message">{message.content}</div>
  ),
}));

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
    localStorage.clear();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(window, 'open').mockImplementation(() => null);

    const store = useConversationStore.getState();
    store.clearConversations();
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

  it('keeps OAuth prompts through streaming, then shows success after click', async () => {
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
      vi.advanceTimersByTime(3000);
    });

    expect(document.body.textContent).not.toContain('Gmail connected');

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

    expect(document.body.textContent).not.toContain('Connect Gmail');

    act(() => {
      root.unmount();
    });
  });

  it('coalesces token updates into one render batch per flush interval', async () => {
    const { root } = renderChatView();

    await act(async () => {
      mocks.asyncOptions.onToken({
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        content: 'Hello',
        responseStart: 0,
      });
      mocks.asyncOptions.onToken({
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        content: ' world',
        responseStart: 5,
      });
    });

    expect(document.body.textContent).not.toContain('Hello world');

    // STREAM_RENDER_INTERVAL_MS in ChatView. Each flush re-parses the whole
    // answer through remark/rehype, so the batch window is deliberately wider
    // than one frame.
    await act(async () => {
      vi.advanceTimersByTime(119);
    });
    expect(document.body.textContent).not.toContain('Hello world');

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(document.body.textContent).toContain('Hello world');

    act(() => root.unmount());
  });

  it('keeps a paused reading position when streaming completes', async () => {
    const { root } = renderChatView();
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    const scroller = document.querySelector(
      '[aria-label="Conversation messages"]',
    ) as HTMLDivElement;

    await act(async () => {
      scroller.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -40 }),
      );
    });
    scrollIntoView.mockClear();

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

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Response complete');

    act(() => root.unmount());
  });
});
