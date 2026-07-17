import React, { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { useAsyncChat } from '@/hooks/useAsyncChat';

import { fetchWithTimeout } from '@/utils/fetchWithTimeout';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: any) => void>>();
  const fetchWithTimeoutMock = vi.fn();
  const manager = {
    isConnected: true,
    subscribeToJob: vi.fn(),
    unsubscribeFromJob: vi.fn(),
    subscribeToChat: vi.fn(),
    unsubscribeFromChat: vi.fn(),
    on: vi.fn((type: string, handler: (data: any) => void) => {
      const set = handlers.get(type) || new Set<(data: any) => void>();
      set.add(handler);
      handlers.set(type, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) handlers.delete(type);
      };
    }),
  };

  return {
    fetchWithTimeoutMock,
    handlers,
    manager,
  };
});

vi.mock('@/services/websocket', () => ({
  getWebSocketManager: vi.fn(() => mocks.manager),
}));

vi.mock('@/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: mocks.fetchWithTimeoutMock,
  FetchTimeoutError: class FetchTimeoutError extends Error {},
}));

vi.mock('@/utils/app/visibilityAwareTimer', () => ({
  shouldRunExpensiveOperation: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@/utils/logger', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

type UseAsyncChatApi = ReturnType<typeof useAsyncChat>;

function response(body: any, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.status && init.status >= 400 ? 'Error' : 'OK',
    json: vi.fn().mockResolvedValue(body),
  } as any;
}

function emit(type: string, data: any): void {
  const handlers = Array.from(mocks.handlers.get(type) || []);
  handlers.forEach((handler) => handler(data));
}

function Probe({
  options,
  onApi,
}: {
  options: Parameters<typeof useAsyncChat>[0];
  onApi: (api: UseAsyncChatApi) => void;
}) {
  const api = useAsyncChat(options);

  useEffect(() => {
    onApi(api);
  }, [api, onApi]);

  return null;
}

function renderProbe(options: Parameters<typeof useAsyncChat>[0]) {
  let api: UseAsyncChatApi | null = null;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <Probe
        options={options}
        onApi={(nextApi) => {
          api = nextApi;
        }}
      />,
    );
  });

  return {
    root,
    get api() {
      if (!api) throw new Error('useAsyncChat API was not initialized');
      return api;
    },
  };
}

describe('useAsyncChat streaming callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.handlers.clear();
    mocks.manager.isConnected = true;
    localStorage.clear();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.fetchWithTimeoutMock.mockImplementation(async (url: string) => {
      if (url === '/api/chat/async') {
        return response({ jobId: 'job-1', status: 'pending' });
      }
      if (url === '/api/chat/async?jobId=job-1') {
        return response({
          jobId: 'job-1',
          status: 'pending',
          conversationId: 'conv-1',
          createdAt: 1,
          updatedAt: 1,
        });
      }
      throw new Error(`Unexpected fetchWithTimeout URL: ${url}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('subscribes to chat token streaming and forwards live events', async () => {
    const onToken = vi.fn();
    const onIntermediateStep = vi.fn();
    const onProgress = vi.fn();
    const onComplete = vi.fn();
    const { root, api } = renderProbe({
      userId: 'user-1',
      onToken,
      onIntermediateStep,
      onProgress,
      onComplete,
    });

    await act(async () => {
      await api.startAsyncJob(
        [{ role: 'user', content: 'hello' }],
        {},
        'user-1',
        'conv-1',
        'Test chat',
        'turn-1',
        'assistant-1',
      );
    });

    expect(mocks.manager.subscribeToJob).toHaveBeenCalledWith('job-1');
    expect(mocks.manager.subscribeToChat).toHaveBeenCalledWith('conv-1');
    expect(mocks.manager.on).toHaveBeenCalledWith(
      'chat_token',
      expect.any(Function),
    );
    expect(mocks.manager.on).toHaveBeenCalledWith(
      'chat_intermediate_step',
      expect.any(Function),
    );
    expect(mocks.manager.on).toHaveBeenCalledWith(
      'chat_complete',
      expect.any(Function),
    );

    const progressCallsBeforeToken = onProgress.mock.calls.length;

    await act(async () => {
      emit('chat_token', {
        type: 'chat_token',
        conversationId: 'conv-1',
        jobId: 'job-1',
        turnId: 'turn-1',
        assistantMessageId: 'assistant-1',
        content: 'Hel',
      });
    });

    expect(onToken).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        jobId: 'job-1',
        content: 'Hel',
      }),
    );
    expect(onProgress).toHaveBeenCalledTimes(progressCallsBeforeToken);

    await act(async () => {
      emit('job_status', {
        jobId: 'job-1',
        status: 'streaming',
        conversationId: 'conv-1',
        partialResponse: 'Hello',
        createdAt: 1,
        updatedAt: 2,
      });
    });
    await act(async () => {
      emit('chat_token', {
        type: 'chat_token',
        conversationId: 'conv-1',
        jobId: 'job-1',
        turnId: 'turn-1',
        assistantMessageId: 'assistant-1',
        content: 'lo',
      });
    });

    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        status: 'streaming',
        partialResponse: 'Hello',
      }),
    );

    const step = {
      parent_id: 'root',
      function_ancestry: {
        node_id: 'search-1',
        parent_id: null,
        function_name: 'search',
        depth: 0,
      },
      payload: {
        event_type: 'TOOL_START',
        event_timestamp: 1,
        name: 'search',
        UUID: 'search-1',
      },
    };

    await act(async () => {
      emit('chat_intermediate_step', {
        type: 'chat_intermediate_step',
        conversationId: 'conv-1',
        jobId: 'job-1',
        assistantMessageId: 'assistant-1',
        step,
      });
    });

    expect(onIntermediateStep).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        jobId: 'job-1',
        step,
      }),
    );
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        status: 'streaming',
        intermediateSteps: [step],
      }),
    );

    await act(async () => {
      emit('chat_complete', {
        type: 'chat_complete',
        conversationId: 'conv-1',
        jobId: 'job-1',
        turnId: 'turn-1',
        assistantMessageId: 'assistant-1',
        fullResponse: 'Hello',
        intermediateSteps: [step],
      });
    });

    expect(onComplete).toHaveBeenCalledWith(
      'Hello',
      [step],
      expect.any(Number),
      'conv-1',
      expect.objectContaining({
        turnId: 'turn-1',
        assistantMessageId: 'assistant-1',
        jobId: 'job-1',
      }),
    );
    expect(mocks.manager.unsubscribeFromJob).toHaveBeenCalledWith('job-1');
    expect(mocks.manager.unsubscribeFromChat).toHaveBeenCalledWith('conv-1');

    const tokenCalls = onToken.mock.calls.length;
    await act(async () => {
      emit('chat_token', {
        type: 'chat_token',
        conversationId: 'conv-1',
        jobId: 'job-1',
        content: ' late',
      });
    });
    expect(onToken).toHaveBeenCalledTimes(tokenCalls);

    act(() => {
      root.unmount();
    });
  });
});
