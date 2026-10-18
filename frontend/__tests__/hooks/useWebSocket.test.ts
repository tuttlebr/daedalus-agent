import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import {
  useWebSocket,
  type UseWebSocketOptions,
  type UseWebSocketReturn,
} from '@/hooks/useWebSocket';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data?: any) => void>>();
  const manager = {
    isConnected: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn((type: string, callback: (data?: any) => void) => {
      const listeners = handlers.get(type) || new Set();
      listeners.add(callback);
      handlers.set(type, listeners);
      return () => listeners.delete(callback);
    }),
    subscribeToJob: vi.fn(),
    unsubscribeFromJob: vi.fn(),
    subscribeToChat: vi.fn(),
    unsubscribeFromChat: vi.fn(),
  };
  return { handlers, manager };
});
vi.mock('@/services/websocket', () => ({
  getWebSocketManager: () => mocks.manager,
}));
vi.mock('@/utils/logger', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    debug = vi.fn();
  },
}));

function emit(type: string, data?: any) {
  act(() => mocks.handlers.get(type)?.forEach((listener) => listener(data)));
}

describe('useWebSocket behavior through the mounted hook', () => {
  let root: Root;
  let host: HTMLDivElement;
  let api: UseWebSocketReturn;
  function Probe({ options = {} }: { options?: UseWebSocketOptions }) {
    api = useWebSocket(options);
    return null;
  }
  function render(options: UseWebSocketOptions = {}) {
    act(() => root.render(React.createElement(Probe, { options })));
  }
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.manager.isConnected = false;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    expect(
      [...mocks.handlers.values()].every((listeners) => listeners.size === 0),
    ).toBe(true);
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('acquires an existing connection and releases it on unmount', () => {
    mocks.manager.isConnected = true;
    render();
    expect(api.isConnected).toBe(true);
    expect(mocks.manager.connect).toHaveBeenCalledOnce();
    act(() => root.render(null));
    expect(mocks.manager.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps the shared connection until its last hook releases it', () => {
    function Probes({ second }: { second: boolean }) {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(Probe, { key: 'first' }),
        second && React.createElement(Probe, { key: 'second' }),
      );
    }
    act(() => root.render(React.createElement(Probes, { second: true })));
    act(() => root.render(React.createElement(Probes, { second: false })));
    expect(mocks.manager.disconnect).not.toHaveBeenCalled();
    act(() => root.render(null));
    expect(mocks.manager.disconnect).toHaveBeenCalledOnce();
  });

  it('does not acquire a connection or handlers while disabled', () => {
    render({ enabled: false });
    expect(mocks.manager.connect).not.toHaveBeenCalled();
    expect(mocks.manager.on).not.toHaveBeenCalled();
    expect(api.isConnected).toBe(false);
    render({ enabled: true });
    expect(mocks.manager.connect).toHaveBeenCalledOnce();
    render({ enabled: false });
    expect(mocks.manager.disconnect).toHaveBeenCalledOnce();
    expect(
      [...mocks.handlers.values()].every((listeners) => listeners.size === 0),
    ).toBe(true);
  });

  it('forwards job and conversation subscriptions from its public API', () => {
    render();
    api.subscribeToJob('job-a');
    api.unsubscribeFromJob('job-a');
    api.subscribeToChat('chat-a');
    api.unsubscribeFromChat('chat-a');
    expect(mocks.manager.subscribeToJob).toHaveBeenCalledWith('job-a');
    expect(mocks.manager.unsubscribeFromJob).toHaveBeenCalledWith('job-a');
    expect(mocks.manager.subscribeToChat).toHaveBeenCalledWith('chat-a');
    expect(mocks.manager.unsubscribeFromChat).toHaveBeenCalledWith('chat-a');
  });

  it('tracks connection and streaming state from delivered events', () => {
    const onConnected = vi.fn(),
      onDisconnected = vi.fn(),
      onStreamingStateChanged = vi.fn();
    render({ onConnected, onDisconnected, onStreamingStateChanged });
    const streamingStates = {
      first: { conversationId: 'first', sessionId: 's' },
    };
    emit('connected', { streamingStates });
    expect(api.isConnected).toBe(true);
    expect(api.streamingStates).toEqual({ first: true });
    expect(onConnected).toHaveBeenCalledWith(streamingStates);
    emit('streaming_started', { conversationId: 'second' });
    emit('streaming_ended', { conversationId: 'first' });
    expect(api.streamingStates).toEqual({ second: true });
    expect(onStreamingStateChanged.mock.calls).toEqual([
      ['second', true],
      ['first', false],
    ]);
    emit('disconnected');
    expect(api.isConnected).toBe(false);
    expect(onDisconnected).toHaveBeenCalledOnce();
  });

  it('delivers sync and autonomy events to the latest callbacks without reconnecting', () => {
    const old = vi.fn(),
      current = vi.fn();
    const options = {
      onConversationUpdated: vi.fn(),
      onConversationDeleted: vi.fn(),
      onConversationListChanged: vi.fn(),
      onSelectedConversationChanged: vi.fn(),
      onAutonomyStatus: vi.fn(),
      onAutonomyRunEvent: vi.fn(),
      onAutonomyFeedUpdated: vi.fn(),
    };
    render({ ...options, onConversationUpdated: old });
    const registrations = mocks.manager.on.mock.calls.length;
    render({ ...options, onConversationUpdated: current });
    const conversation = { id: 'chat' };
    emit('conversation_updated', { conversation });
    emit('conversation_deleted', { conversationId: 'chat' });
    emit('conversation_list_changed');
    emit('selected_conversation_changed', { conversationId: 'other' });
    const event = { id: 'run' };
    emit('autonomy_status', event);
    emit('autonomy_run_event', event);
    emit('autonomy_feed_updated', event);
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledWith(conversation);
    expect(options.onConversationDeleted).toHaveBeenCalledWith('chat');
    expect(options.onConversationListChanged).toHaveBeenCalledOnce();
    expect(options.onSelectedConversationChanged).toHaveBeenCalledWith('other');
    for (const callback of [
      options.onAutonomyStatus,
      options.onAutonomyRunEvent,
      options.onAutonomyFeedUpdated,
    ])
      expect(callback).toHaveBeenCalledWith(event);
    expect(mocks.manager.on).toHaveBeenCalledTimes(registrations);
    expect(mocks.manager.connect).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'handles hidden-page connection policy (streaming=%s)',
    (streaming) => {
      let visibility = 'visible';
      vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
        () => visibility as DocumentVisibilityState,
      );
      const postMessage = vi.fn();
      vi.stubGlobal(
        'navigator',
        Object.create(navigator, {
          serviceWorker: { value: { controller: { postMessage } } },
        }),
      );
      render();
      if (streaming) emit('streaming_started', { conversationId: 'active' });
      visibility = 'hidden';
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      expect(mocks.manager.disconnect).toHaveBeenCalledTimes(streaming ? 0 : 1);
      expect(postMessage).toHaveBeenLastCalledWith({
        type: 'SET_BACKGROUND_TASKS',
        enabled: false,
      });
      visibility = 'visible';
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      expect(mocks.manager.connect).toHaveBeenCalledTimes(2);
      expect(postMessage).toHaveBeenLastCalledWith({
        type: 'SET_BACKGROUND_TASKS',
        enabled: true,
      });
    },
  );
});
