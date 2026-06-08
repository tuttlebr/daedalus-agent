import { getSession } from '@/utils/auth/session';

import handler from '@/pages/api/conversations/[id]/traces';

import { getStreamingStates, jsonGet } from '@/server/session/redis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSismember = vi.fn().mockResolvedValue(1);

vi.mock('@/server/session/redis', () => ({
  getRedis: vi.fn(() => ({
    sismember: mockSismember,
  })),
  getStreamingStates: vi.fn().mockResolvedValue({}),
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
  jsonGet: vi.fn(),
}));

vi.mock('@/utils/auth/session', () => ({
  getSession: vi.fn().mockResolvedValue({ username: 'testuser' }),
}));

function createMockReqRes(method: string, query: any = {}) {
  const req = { method, query } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
  return { req, res };
}

describe('conversations/[id]/traces API handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getSession as any).mockResolvedValue({ username: 'testuser' });
    mockSismember.mockResolvedValue(1);
    (getStreamingStates as any).mockResolvedValue({});
  });

  it('returns 401 when no session exists', async () => {
    (getSession as any).mockResolvedValue(null);
    const { req, res } = createMockReqRes('GET', { id: 'conv-1' });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not authenticated' });
  });

  it('returns 403 when the user does not own the conversation', async () => {
    mockSismember.mockResolvedValue(0);
    const { req, res } = createMockReqRes('GET', { id: 'conv-1' });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Forbidden: You do not have access to this conversation',
    });
  });

  it('exports saved intermediate steps as JSONL using the conversation id filename', async () => {
    const step = {
      parent_id: 'root',
      function_ancestry: {
        node_id: 'step-1',
        parent_id: null,
        function_name: 'search',
        depth: 0,
      },
      payload: {
        event_type: 'TOOL_START',
        event_timestamp: 1710000000,
        name: 'search',
        UUID: 'step-1',
      },
    };
    (jsonGet as any).mockResolvedValueOnce({
      id: 'session-abc',
      name: 'Traceable conversation',
      messages: [
        { id: 'user-1', role: 'user', content: 'Search' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Searching',
          metadata: { turnId: 'turn-1', jobId: 'job-1' },
          intermediateSteps: [step],
        },
      ],
    });
    const { req, res } = createMockReqRes('GET', { id: 'session-abc' });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/x-ndjson; charset=utf-8',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="session-abc.jsonl"',
    );

    const body = res.send.mock.calls[0][0] as string;
    const lines = body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      session_id: 'session-abc',
      conversation_id: 'session-abc',
      conversation_name: 'Traceable conversation',
      message_index: 1,
      message_id: 'assistant-1',
      role: 'assistant',
      turn_id: 'turn-1',
      job_id: 'job-1',
      step_index: 0,
      trace_index: 0,
      live: false,
      parent_id: 'root',
      payload: { UUID: 'step-1', event_type: 'TOOL_START' },
    });
  });

  it('includes live streaming steps without duplicating saved steps', async () => {
    const savedStep = {
      payload: { UUID: 'saved-step', event_type: 'TOOL_START' },
    };
    const liveStep = {
      payload: { UUID: 'live-step', event_type: 'TOOL_END' },
    };
    (jsonGet as any)
      .mockResolvedValueOnce({
        id: 'conv-1',
        name: 'Streaming conversation',
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            metadata: { turnId: 'turn-1', jobId: 'job-1' },
            intermediateSteps: [savedStep],
          },
        ],
      })
      .mockResolvedValueOnce([savedStep, liveStep])
      .mockResolvedValueOnce({ turnId: 'turn-live' });
    (getStreamingStates as any).mockResolvedValue({
      'conv-1': {
        conversationId: 'conv-1',
        sessionId: 'job-1',
        startedAt: 1710000000000,
        userId: 'testuser',
      },
    });
    const { req, res } = createMockReqRes('GET', { id: 'conv-1' });

    await handler(req, res);

    const body = res.send.mock.calls[0][0] as string;
    const lines = body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      payload: { UUID: 'saved-step' },
      live: false,
    });
    expect(lines[1]).toMatchObject({
      payload: { UUID: 'live-step' },
      live: true,
      job_id: 'job-1',
      turn_id: 'turn-live',
    });
  });
});
