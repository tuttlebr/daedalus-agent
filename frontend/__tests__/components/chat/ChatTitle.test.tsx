import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ChatTitle } from '@/components/chat/ChatTitle';

import { useConversationStore } from '@/state/conversationStore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const conversation = {
  id: 'conv',
  name: 'Quarterly plan',
  messages: [],
  folderId: null,
} as any;

describe('ChatTitle streaming indicator', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    useConversationStore.setState({
      conversations: [conversation],
      selectedConversationId: 'conv',
      streamingConversationIds: new Set(),
      remoteStreamingConversationIds: new Set(),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = () => {
    act(() => root.render(<ChatTitle />));
    return container.textContent ?? '';
  };

  it('shows nothing when no session is streaming the conversation', () => {
    const text = render();
    expect(text).toContain('Quarterly plan');
    expect(text).not.toContain('Streaming');
  });

  it("shows the local indicator for this tab's own run", () => {
    act(() =>
      useConversationStore.setState({
        streamingConversationIds: new Set(['conv']),
        remoteStreamingConversationIds: new Set(['conv']),
      }),
    );
    const text = render();
    expect(text).toContain('Streaming');
    expect(text).not.toContain('Streaming elsewhere');
  });

  it('shows a run started from another session', () => {
    act(() =>
      useConversationStore.setState({
        remoteStreamingConversationIds: new Set(['conv']),
      }),
    );
    expect(render()).toContain('Streaming elsewhere');
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe(
      'A response is streaming in another session',
    );
  });

  it('ignores remote state for a different conversation', () => {
    act(() =>
      useConversationStore.setState({
        remoteStreamingConversationIds: new Set(['other']),
      }),
    );
    expect(render()).not.toContain('Streaming');
  });

  it('switches to the local indicator once this tab starts the run', () => {
    act(() =>
      useConversationStore.setState({
        remoteStreamingConversationIds: new Set(['conv']),
      }),
    );
    expect(render()).toContain('Streaming elsewhere');
    act(() => useConversationStore.getState().setStreaming('conv', true));
    expect(container.textContent).not.toContain('elsewhere');
    expect(container.textContent).toContain('Streaming');
  });
});
