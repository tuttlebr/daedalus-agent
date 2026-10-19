import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import {
  findCorrelatedAssistantMessage,
  useAsyncChat,
} from '@/hooks/useAsyncChat';

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
    steerJob: vi.fn(),
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

vi.mock('@/utils/logger', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

type UseAsyncChatApi = ReturnType<typeof useAsyncChat>;

describe('orphan response correlation', () => {
  it('selects the exact job response instead of the latest assistant message', () => {
    const matching = {
      id: 'assistant-current',
      role: 'assistant',
      content: 'current answer',
      metadata: { jobId: 'job-current', turnId: 'turn-current' },
    };
    const unrelatedLater = {
      id: 'assistant-later',
      role: 'assistant',
      content: 'later answer',
      metadata: { jobId: 'job-later', turnId: 'turn-later' },
    };

    expect(
      findCorrelatedAssistantMessage([matching, unrelatedLater], {
        jobId: 'job-current',
        turnId: 'turn-current',
      }),
    ).toBe(matching);
  });

  it('does not return an assistant response from another job', () => {
    expect(
      findCorrelatedAssistantMessage(
        [
          {
            role: 'assistant',
            content: 'wrong answer',
            metadata: { jobId: 'job-other', turnId: 'turn-current' },
          },
        ],
        { jobId: 'job-current', turnId: 'turn-current' },
      ),
    ).toBeNull();
  });

  it('uses turn correlation only for legacy messages without a job ID', () => {
    const legacy = {
      id: 'assistant-legacy',
      role: 'assistant',
      content: 'legacy answer',
      metadata: { turnId: 'turn-current' },
    };

    expect(
      findCorrelatedAssistantMessage([legacy], {
        jobId: 'job-current',
        turnId: 'turn-current',
      }),
    ).toBe(legacy);
  });
});

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

function renderProbe(
  options: Parameters<typeof useAsyncChat>[0],
  { strict = false }: { strict?: boolean } = {},
) {
  let api: UseAsyncChatApi | null = null;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const probe = (
    <Probe
      options={options}
      onApi={(nextApi) => {
        api = nextApi;
      }}
    />
  );

  act(() => {
    root.render(strict ? <React.StrictMode>{probe}</React.StrictMode> : probe);
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
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it.each([false, true])(
    'keeps OAuth visible during sibling steps with preceding tokens: %s',
    async (withToken) => {
      const onProgress = vi.fn();
      const probe = renderProbe({ userId: 'alice', onProgress });
      try {
        await act(async () => {
          await probe.api.startAsyncJob([], {}, 'alice', 'conv-1', 'Test');
        });
        const status = {
          jobId: 'job-1',
          conversationId: 'conv-1',
          createdAt: 1,
          updatedAt: 2,
        };
        const prompt = {
          authUrl: 'https://accounts.google.com/auth',
          oauthState: 'pending',
          oauthRequests: [
            { id: 'pending', authUrl: 'https://accounts.google.com/auth' },
          ],
        };
        const step = {
          jobId: 'job-1',
          conversationId: 'conv-1',
          step: { name: 'Sibling completed' },
        };
        act(() => {
          emit('job_status', {
            ...status,
            status: 'oauth_required',
            ...prompt,
          });
          if (withToken)
            emit('chat_token', {
              jobId: 'job-1',
              conversationId: 'conv-1',
              content: 'Sibling answer.',
              responseStart: 0,
            });
          emit('chat_intermediate_step', step);
        });
        expect(onProgress).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: 'oauth_required', ...prompt }),
        );
        expect(probe.api.jobStatusByConversationId['conv-1']).toMatchObject({
          status: 'oauth_required',
          ...prompt,
        });
        // Only the authoritative callback status clears the pending prompt.
        act(() => {
          emit('job_status', { ...status, updatedAt: 3, status: 'streaming' });
          emit('chat_intermediate_step', step);
        });
        expect(onProgress).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: 'streaming' }),
        );
        expect(
          probe.api.jobStatusByConversationId['conv-1'].oauthRequests,
        ).toBeUndefined();
      } finally {
        act(() => probe.root.unmount());
      }
    },
  );

  it('queues live subscriptions during disconnection and resumes token delivery', async () => {
    mocks.manager.isConnected = false;
    const onToken = vi.fn();
    const { root, api } = renderProbe({
      userId: 'alice',
      onToken,
      pollingInterval: 3000,
    });
    await act(async () => {
      await api.startAsyncJob([], {}, 'alice', 'conv-1', 'Test');
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(mocks.manager.subscribeToJob).toHaveBeenCalledWith('job-1');
    expect(mocks.manager.subscribeToChat).toHaveBeenCalledWith('conv-1');
    expect(mocks.fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
    mocks.manager.isConnected = true;
    await act(async () => {
      emit('chat_token', {
        jobId: 'job-1',
        conversationId: 'conv-1',
        content: 'Live',
        responseStart: 0,
      });
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(onToken).toHaveBeenCalledOnce();
    expect(mocks.fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
    expect(mocks.manager.unsubscribeFromJob).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('switches promptly to polling on disconnect without overlapping slow requests', async () => {
    const { root, api } = renderProbe({
      userId: 'alice',
      pollingInterval: 3000,
    });
    await act(async () => {
      await api.startAsyncJob([], {}, 'alice', 'conv-1', 'Test');
    });
    let resolveStatus!: (value: any) => void;
    mocks.fetchWithTimeoutMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    mocks.manager.isConnected = false;
    await act(async () => {
      emit('disconnected', undefined);
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(mocks.fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
    expect(mocks.manager.unsubscribeFromJob).not.toHaveBeenCalled();

    await act(async () => {
      resolveStatus(
        response({
          jobId: 'job-1',
          status: 'streaming',
          conversationId: 'conv-1',
          partialResponse: 'current',
          createdAt: 1,
          updatedAt: 2,
        }),
      );
    });
    act(() => root.unmount());
  });

  it('reconciles a job that finished during a brief disconnection on reconnect', async () => {
    const onComplete = vi.fn();
    const { root, api } = renderProbe({
      userId: 'alice',
      onComplete,
      pollingInterval: 3000,
    });
    await act(async () => {
      await api.startAsyncJob([], {}, 'alice', 'conv-1', 'Test');
    });
    const statusReads = () =>
      mocks.fetchWithTimeoutMock.mock.calls.filter(
        ([url]) => url === '/api/chat/async?jobId=job-1',
      ).length;
    const readsBefore = statusReads();
    mocks.fetchWithTimeoutMock.mockImplementation(async () =>
      response({
        jobId: 'job-1',
        status: 'completed',
        conversationId: 'conv-1',
        fullResponse: 'Finished while offline.',
        finalizedAt: 2,
        createdAt: 1,
        updatedAt: 2,
      }),
    );

    // The terminal job_status was published while the socket was down, and
    // the socket returned before the next fallback poll.
    mocks.manager.isConnected = false;
    await act(async () => {
      emit('disconnected', undefined);
      await vi.advanceTimersByTimeAsync(1_000);
    });
    mocks.manager.isConnected = true;
    await act(async () => {
      emit('connected', { userId: 'alice', streamingStates: {} });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(statusReads()).toBe(readsBefore + 1);
    expect(onComplete).toHaveBeenCalledWith(
      'Finished while offline.',
      undefined,
      2,
      'conv-1',
      expect.objectContaining({ jobId: 'job-1' }),
    );
    act(() => root.unmount());
  });

  it('reports the failed job identity and duration with a terminal error', async () => {
    const onError = vi.fn();
    const { root, api } = renderProbe({ userId: 'alice', onError });
    await act(async () => {
      await api.startAsyncJob([], {}, 'alice', 'conv-1', 'Test');
    });
    await act(async () => {
      emit('job_status', {
        jobId: 'job-1',
        status: 'error',
        error: 'Backend disconnected',
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        partialResponse: 'Partial answer',
        generationDurationMs: 4200,
        finalizedAt: 2,
        createdAt: 1,
        updatedAt: 2,
      });
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      'Backend disconnected',
      expect.objectContaining({
        jobId: 'job-1',
        conversationId: 'conv-1',
        assistantMessageId: 'assistant-1',
        partialResponse: 'Partial answer',
        generationDurationMs: 4200,
      }),
    );
    act(() => root.unmount());
  });

  it('keeps handling live events after effects are re-run', async () => {
    // Strict Mode and Fast Refresh unmount and re-run effects in place.
    const onToken = vi.fn();
    const { root, api } = renderProbe(
      { userId: 'alice', onToken },
      { strict: true },
    );
    await act(async () => {
      await api.startAsyncJob([], {}, 'alice', 'conv-1', 'Test');
    });
    await act(async () => {
      emit('chat_token', {
        jobId: 'job-1',
        conversationId: 'conv-1',
        content: 'Live',
        responseStart: 0,
      });
    });
    expect(onToken).toHaveBeenCalledWith(
      expect.objectContaining({ partialResponse: 'Live' }),
    );
    act(() => root.unmount());
  });

  it('delivers same-length corrections and tool-only progress through polling', async () => {
    // WebSocket delivery is unavailable, so HTTP status reads carry progress.
    mocks.manager.isConnected = false;
    mocks.fetchWithTimeoutMock.mockImplementation(async (url: string) =>
      response(
        url === '/api/chat/async'
          ? { jobId: 'job-1', status: 'pending' }
          : {
              jobId: 'job-1',
              status: 'streaming',
              partialResponse: 'abc',
              intermediateSteps: [],
              conversationId: 'conv-1',
              createdAt: 1,
              updatedAt: 1,
            },
      ),
    );
    const onProgress = vi.fn();
    const { root, api } = renderProbe({
      userId: 'alice',
      pollingInterval: 3000,
      onProgress,
    });
    await act(async () => {
      await api.startAsyncJob([], {}, 'alice', 'conv-1', 'Test');
    });
    mocks.fetchWithTimeoutMock.mockResolvedValue(
      response({
        jobId: 'job-1',
        status: 'streaming',
        partialResponse: 'xyz',
        intermediateSteps: [],
        conversationId: 'conv-1',
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ partialResponse: 'xyz' }),
    );

    const steps = [{ payload: { event_type: 'TOOL_START', name: 'search' } }];
    mocks.fetchWithTimeoutMock.mockResolvedValue(
      response({
        jobId: 'job-1',
        status: 'streaming',
        partialResponse: 'xyz',
        intermediateSteps: steps,
        conversationId: 'conv-1',
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ intermediateSteps: steps }),
    );
    act(() => root.unmount());
  });

  it('keeps newer live progress when an older fallback response arrives', async () => {
    mocks.manager.isConnected = false;
    const onProgress = vi.fn();
    const { root, api } = renderProbe({
      userId: 'alice',
      pollingInterval: 3000,
      onProgress,
    });
    await act(async () => {
      await api.startAsyncJob([], {}, 'alice', 'conv-1', 'Test');
    });
    let resolveStatus!: (value: any) => void;
    mocks.fetchWithTimeoutMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    mocks.manager.isConnected = true;
    const step = { payload: { event_type: 'TOOL_START', name: 'search' } };
    await act(async () => {
      emit('chat_intermediate_step', {
        jobId: 'job-1',
        conversationId: 'conv-1',
        step,
      });
      resolveStatus(
        response({
          jobId: 'job-1',
          status: 'pending',
          conversationId: 'conv-1',
          intermediateSteps: [],
          createdAt: 1,
          updatedAt: 1,
        }),
      );
    });
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'streaming',
        intermediateSteps: [step],
      }),
    );
    expect(onProgress).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it.each([true, false])(
    'reports empty finalized responses consistently (WebSocket connected=%s)',
    async (connected) => {
      mocks.manager.isConnected = connected;
      mocks.fetchWithTimeoutMock.mockImplementation(async (url: string) =>
        response(
          url === '/api/chat/async'
            ? { jobId: 'job-1', status: 'pending' }
            : {
                jobId: 'job-1',
                status: 'completed',
                fullResponse: '',
                finalizedAt: 2,
                conversationId: 'conv-1',
                createdAt: 1,
                updatedAt: 2,
              },
        ),
      );
      const onComplete = vi.fn();
      const { root, api } = renderProbe({
        userId: 'alice',
        onComplete,
      });
      await act(async () => {
        await api.startAsyncJob([], {}, 'alice', 'conv-1', 'Test');
      });
      expect(onComplete).toHaveBeenCalledOnce();
      expect(onComplete.mock.calls[0][0]).toBe('');
      act(() => root.unmount());
    },
  );

  it('stops during submission and ignores the late job ID', async () => {
    let resolvePost!: (value: any) => void;
    mocks.fetchWithTimeoutMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );
    const stop = vi
      .fn()
      .mockResolvedValue(response({ success: true, canceled: true }));
    vi.stubGlobal('fetch', stop);
    const onProgress = vi.fn();
    const probe = renderProbe({ userId: 'alice', onProgress });
    let pending!: Promise<string>;
    await act(async () => {
      pending = probe.api.startAsyncJob([], {}, 'alice', 'conv-1', 'fixture');
    });
    const body = JSON.parse(mocks.fetchWithTimeoutMock.mock.calls[0][1].body);
    await act(async () => {
      await probe.api.cancelJob('conv-1');
    });
    expect(stop.mock.calls[0][0]).toBe(
      `/api/chat/async?submissionId=${body.submissionId}`,
    );
    await act(async () => {
      resolvePost(response({ jobId: 'late', status: 'pending' }));
      await pending;
    });
    expect(mocks.manager.subscribeToJob).not.toHaveBeenCalled();
    expect(mocks.fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalled();
    act(() => probe.root.unmount());
  });

  it('ignores a stale poll that arrives after confirmed Stop', async () => {
    let resolveStatus!: (value: any) => void;
    mocks.fetchWithTimeoutMock.mockImplementation(async (url: string) => {
      if (url === '/api/chat/async')
        return response({ jobId: 'job-1', status: 'pending' });
      return new Promise((resolve) => {
        resolveStatus = resolve;
      });
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ success: true, canceled: true })),
    );
    const onProgress = vi.fn();
    const probe = renderProbe({ userId: 'alice', onProgress });
    let pending!: Promise<string>;
    await act(async () => {
      pending = probe.api.startAsyncJob([], {}, 'alice', 'conv-1', 'fixture');
    });
    await act(async () => {
      await probe.api.cancelJob('conv-1');
    });
    await act(async () => {
      resolveStatus(
        response({
          jobId: 'job-1',
          status: 'streaming',
          conversationId: 'conv-1',
          partialResponse: 'late output',
        }),
      );
      await pending;
    });
    expect(onProgress).not.toHaveBeenCalled();
    act(() => probe.root.unmount());
  });

  it('preserves tracking after failed cancellation and permits retry', async () => {
    const onToken = vi.fn();
    const { root, api } = renderProbe({ userId: 'user-1', onToken });
    await act(async () => {
      await api.startAsyncJob([], {}, 'user-1', 'conv-1', 'Test');
    });
    const stored = JSON.stringify(localStorage);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response({ error: 'Unavailable' }, { ok: false, status: 503 }),
        ),
    );
    await act(async () => {
      await expect(api.cancelJob('conv-1')).rejects.toThrow();
    });
    expect(JSON.stringify(localStorage)).toBe(stored);
    expect(mocks.manager.unsubscribeFromJob).not.toHaveBeenCalled();
    await act(async () => {
      emit('chat_token', {
        jobId: 'job-1',
        conversationId: 'conv-1',
        content: 'still working',
        responseStart: 0,
      });
    });
    expect(onToken).toHaveBeenCalled();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ success: true, canceled: true })),
    );
    await act(async () => {
      await api.cancelJob('conv-1');
    });
    expect(mocks.manager.unsubscribeFromJob).toHaveBeenCalledWith('job-1');
    act(() => root.unmount());
  });

  it('retries an unconfirmed direction with the same command ID', async () => {
    const { root, api } = renderProbe({ userId: 'alice' });
    await act(async () => {
      await api.startAsyncJob([], {}, 'alice', 'conv-1', 'Test');
    });
    const commandIds = () =>
      mocks.manager.steerJob.mock.calls.map(([, , commandId]) => commandId);
    mocks.manager.steerJob.mockRejectedValueOnce(
      new Error('Delivery was not confirmed. Retry this direction.'),
    );
    await act(async () => {
      await expect(api.steerJob('conv-1', 'Focus on storage')).rejects.toThrow(
        'not confirmed',
      );
    });
    mocks.manager.steerJob.mockResolvedValue(undefined);
    await act(async () => {
      // The backend may have applied the first attempt; retrying must not
      // apply the same direction twice.
      await api.steerJob('conv-1', 'Focus on storage');
    });
    expect(mocks.manager.steerJob.mock.calls[1].slice(0, 2)).toEqual([
      'job-1',
      'Focus on storage',
    ]);
    expect(commandIds()[1]).toBe(commandIds()[0]);

    await act(async () => {
      // A confirmed direction sent again is a new, deliberate command.
      await api.steerJob('conv-1', 'Focus on storage');
    });
    expect(new Set(commandIds()).size).toBe(2);
    await expect(api.steerJob('conv-2', 'Elsewhere')).rejects.toThrow(
      'No active response',
    );
    act(() => root.unmount());
  });

  it('repairs a lost token range promptly while live delivery continues', async () => {
    const onToken = vi.fn();
    const onProgress = vi.fn();
    const { root, api } = renderProbe({ userId: 'alice', onToken, onProgress });
    await act(async () => {
      await api.startAsyncJob([], {}, 'alice', 'conv-1', 'Test');
    });
    const statusRequests = () =>
      mocks.fetchWithTimeoutMock.mock.calls.filter(
        ([url]) => url === '/api/chat/async?jobId=job-1',
      ).length;
    expect(statusRequests()).toBe(1);

    // Tokens 5..20 were published while this socket was resubscribing.
    mocks.fetchWithTimeoutMock.mockImplementation(async () =>
      response({
        jobId: 'job-1',
        status: 'streaming',
        conversationId: 'conv-1',
        partialResponse: 'Hello, missing words',
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    await act(async () => {
      emit('chat_token', {
        jobId: 'job-1',
        conversationId: 'conv-1',
        content: 'Hello',
        responseStart: 0,
      });
      emit('chat_token', {
        jobId: 'job-1',
        conversationId: 'conv-1',
        content: ' world',
        responseStart: 20,
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    // A recent live event must not suppress repair of a known gap.
    expect(statusRequests()).toBe(2);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'streaming',
        partialResponse: 'Hello, missing words world',
      }),
    );

    await act(async () => {
      emit('chat_token', {
        jobId: 'job-1',
        conversationId: 'conv-1',
        content: '!',
        responseStart: 26,
      });
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(onToken).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: '!',
        partialResponse: 'Hello, missing words world!',
      }),
    );
    // Contiguous delivery after the repair needs no further requests.
    expect(statusRequests()).toBe(2);
    act(() => root.unmount());
  });

  it('retries a repair whose snapshot still lags the live tokens', async () => {
    const onToken = vi.fn();
    const { root, api } = renderProbe({
      userId: 'alice',
      onToken,
      pollingInterval: 3000,
    });
    await act(async () => {
      await api.startAsyncJob([], {}, 'alice', 'conv-1', 'Test');
    });
    let snapshot = 'Hello';
    mocks.fetchWithTimeoutMock.mockImplementation(async () =>
      response({
        jobId: 'job-1',
        status: 'streaming',
        conversationId: 'conv-1',
        partialResponse: snapshot,
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    await act(async () => {
      emit('chat_token', {
        jobId: 'job-1',
        conversationId: 'conv-1',
        content: ' again',
        responseStart: 11,
      });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onToken).toHaveBeenLastCalledWith(
      expect.objectContaining({ partialResponse: '' }),
    );
    snapshot = 'Hello there';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => {
      emit('chat_token', {
        jobId: 'job-1',
        conversationId: 'conv-1',
        content: '.',
        responseStart: 17,
      });
    });
    expect(onToken).toHaveBeenLastCalledWith(
      expect.objectContaining({ partialResponse: 'Hello there again.' }),
    );
    act(() => root.unmount());
  });

  it('keeps accumulated text when a status push omits the response', async () => {
    const onToken = vi.fn();
    const { root, api } = renderProbe({ userId: 'alice', onToken });
    await act(async () => {
      await api.startAsyncJob([], {}, 'alice', 'conv-1', 'Test');
    });
    const requestsBefore = mocks.fetchWithTimeoutMock.mock.calls.length;
    await act(async () => {
      emit('chat_token', {
        jobId: 'job-1',
        conversationId: 'conv-1',
        content: 'abc',
        responseStart: 0,
      });
      emit('job_status', {
        jobId: 'job-1',
        status: 'oauth_required',
        conversationId: 'conv-1',
        authUrl: 'https://accounts.google.com/auth',
        createdAt: 1,
        updatedAt: 2,
      });
      emit('chat_token', {
        jobId: 'job-1',
        conversationId: 'conv-1',
        content: 'def',
        responseStart: 3,
      });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onToken).toHaveBeenLastCalledWith(
      expect.objectContaining({ partialResponse: 'abcdef' }),
    );
    expect(mocks.fetchWithTimeoutMock).toHaveBeenCalledTimes(requestsBefore);
    act(() => root.unmount());
  });

  it.each([
    [
      'recovers the saved answer',
      {
        messages: [
          {
            id: 'assistant-old',
            role: 'assistant',
            content: 'Saved answer',
            metadata: { jobId: 'job-old', turnId: 'turn-old' },
          },
        ],
      },
    ],
    ['reports the unavailable status', { messages: [] }],
  ])(
    'reconciles a resumed job whose status expired and %s',
    async (_label, conversation) => {
      localStorage.setItem(
        'asyncJobs_alice',
        JSON.stringify([
          {
            jobId: 'job-old',
            conversationId: 'conv-1',
            userId: 'alice',
            timestamp: Date.now(),
            turnId: 'turn-old',
            assistantMessageId: 'assistant-old',
          },
        ]),
      );
      mocks.fetchWithTimeoutMock.mockImplementation(async (url: string) => {
        if (url === '/api/chat/async?jobId=job-old')
          return {
            ...response({ error: 'Job not found' }, { ok: false, status: 404 }),
            body: { cancel: vi.fn() },
          };
        if (url === '/api/conversations/conv-1') return response(conversation);
        throw new Error(`Unexpected fetchWithTimeout URL: ${url}`);
      });
      const onComplete = vi.fn();
      const onError = vi.fn();
      const { root } = renderProbe({ userId: 'alice', onComplete, onError });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      if (conversation.messages.length) {
        expect(onComplete).toHaveBeenCalledWith(
          'Saved answer',
          undefined,
          expect.any(Number),
          'conv-1',
          expect.objectContaining({
            jobId: 'job-old',
            assistantMessageId: 'assistant-old',
          }),
        );
        expect(onError).not.toHaveBeenCalled();
      } else {
        expect(onError).toHaveBeenCalledWith(
          expect.stringContaining('no longer available'),
          expect.objectContaining({
            jobId: 'job-old',
            conversationId: 'conv-1',
            assistantMessageId: 'assistant-old',
          }),
        );
        expect(onComplete).not.toHaveBeenCalled();
      }
      expect(localStorage.getItem('asyncJobs_alice')).toBe('[]');
      expect(mocks.manager.unsubscribeFromJob).toHaveBeenCalledWith('job-old');
      act(() => root.unmount());
    },
  );

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
        responseStart: 0,
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
        responseStart: 3,
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
        generationDurationMs: 5500,
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
        generationDurationMs: 5500,
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
