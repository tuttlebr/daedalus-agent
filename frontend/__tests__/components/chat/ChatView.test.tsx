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
      clearPersistedJob: vi.fn(),
      isPolling: false,
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
});
