import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve4: vi.fn(),
  fetchWithTimeout: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  default: {
    resolve4: mocks.resolve4,
  },
  resolve4: mocks.resolve4,
}));

vi.mock('@/pages/api/session/redis', () => ({
  getPublisher: vi.fn(() => ({ publish: vi.fn().mockResolvedValue(undefined) })),
  getRedis: vi.fn(() => ({
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn().mockResolvedValue(1),
  })),
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  jsonDel: vi.fn().mockResolvedValue(0),
  setStreamingState: vi.fn(),
  clearStreamingState: vi.fn(),
}));

vi.mock('@/utils/sync/publish', () => ({
  publishStreamingState: vi.fn().mockResolvedValue(undefined),
  publishConversationUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

vi.mock('@/utils/auth/session', () => ({
  getSession: vi.fn().mockResolvedValue({ username: 'testuser' }),
}));

import handler, {
  appendDocumentAttachmentContext,
  buildBoundedMessagesForNat,
  buildNatRequestHeaders,
  buildNatSessionId,
  compactDocumentIngestionMessage,
  extractAsyncStreamContentDelta,
  fetchNatJobStatus,
  getDocumentIngestJobRequest,
  isDocumentIngestionRequest,
  resolveAsyncBackendBaseUrls,
} from '@/pages/api/chat/async';
import {
  stripReplayedAssistantPrefix,
} from '@/utils/app/conversationReplay';
import { jsonGet, jsonSetWithExpiry } from '@/pages/api/session/redis';

describe('chat/async backend pinning helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BACKEND_HOST = 'daedalus-backend';
    process.env.BACKEND_NAMESPACE = 'daedalus';
    process.env.BACKEND_PORT = '8000';
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    delete process.env.DEPLOYMENT_MODE;
    delete process.env.DAEDALUS_INTERNAL_API_TOKEN;
    delete process.env.DAEDALUS_DIRECT_DOCUMENT_INGEST_STREAM;
  });

  it('resolves pinned backend pod base URLs from the headless service', async () => {
    mocks.resolve4.mockResolvedValue([
      '10.0.2.61',
      '10.0.3.154',
      '10.0.2.61',
    ]);

    const baseUrls = await resolveAsyncBackendBaseUrls();

    expect(mocks.resolve4).toHaveBeenCalledWith(
      'daedalus-backend-default-pods.daedalus.svc.cluster.local',
    );
    expect(baseUrls).toHaveLength(2);
    expect(baseUrls).toEqual(
      expect.arrayContaining([
        'http://10.0.2.61:8000',
        'http://10.0.3.154:8000',
      ]),
    );
  });

  it('uses the stored natBaseUrl when polling job status', async () => {
    const json = vi.fn().mockResolvedValue({
      job_id: 'job-123',
      status: 'running',
      error: null,
      output: null,
      created_at: '',
      updated_at: '',
      expires_at: '',
    });
    mocks.fetchWithTimeout.mockResolvedValue({
      ok: true,
      status: 200,
      json,
    });

    await fetchNatJobStatus('job-123', {
      jobId: 'job-123',
      natBaseUrl: 'http://10.0.2.61:8000',
      messages: [],
      additionalProps: {},
      userId: 'testuser',
    } as any);

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'http://10.0.2.61:8000/v1/workflow/async/job/job-123',
      { headers: buildNatRequestHeaders('testuser') },
      30000,
    );
  });

  it('sets identity and an isolated NAT session cookie on backend requests', () => {
    expect(
      buildNatRequestHeaders(
        'testuser',
        { 'Content-Type': 'application/json' },
        'job-session-123',
      ),
    ).toEqual({
      'Content-Type': 'application/json',
      'x-user-id': 'testuser',
      Cookie: 'nat-session=job-session-123',
    });
  });

  it('adds the internal API token to backend requests when configured', () => {
    process.env.DAEDALUS_INTERNAL_API_TOKEN = 'internal-secret';

    expect(buildNatRequestHeaders('testuser')).toEqual({
      'x-user-id': 'testuser',
      'x-daedalus-internal-token': 'internal-secret',
      Cookie: 'nat-session=testuser',
    });
  });

  it('derives a stable per-turn NAT session id without exposing the username', () => {
    const first = buildNatSessionId('testuser', 'job-123', 'conv-1', 'turn-1');
    const same = buildNatSessionId('testuser', 'job-123', 'conv-1', 'turn-1');
    const nextTurn = buildNatSessionId('testuser', 'job-456', 'conv-1', 'turn-2');

    expect(first).toBe(same);
    expect(first).toMatch(/^daedalus-[a-f0-9]{32}$/);
    expect(first).not.toContain('testuser');
    expect(nextTurn).not.toBe(first);
  });

  it('uses the stored NAT session id when polling job status', async () => {
    const json = vi.fn().mockResolvedValue({
      job_id: 'job-123',
      status: 'running',
      error: null,
      output: null,
      created_at: '',
      updated_at: '',
      expires_at: '',
    });
    mocks.fetchWithTimeout.mockResolvedValue({
      ok: true,
      status: 200,
      json,
    });

    await fetchNatJobStatus('job-123', {
      jobId: 'job-123',
      natBaseUrl: 'http://10.0.2.61:8000',
      natSessionId: 'job-session-123',
      messages: [],
      additionalProps: {},
      userId: 'testuser',
    } as any);

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'http://10.0.2.61:8000/v1/workflow/async/job/job-123',
      { headers: buildNatRequestHeaders('testuser', {}, 'job-session-123') },
      30000,
    );
  });

  it('preserves prior assistant content so follow-ups have real context', () => {
    const prior = 'A detailed prior assistant response the user wants to reuse.';
    const bounded = buildBoundedMessagesForNat([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: prior, id: 'assistant-1' },
      { role: 'user', content: 'follow up' },
    ]);

    expect(bounded).toHaveLength(3);
    expect(bounded[0]).toEqual({ role: 'user', content: 'first question' });
    expect(bounded[1]).toEqual({ role: 'assistant', content: prior });
    expect(bounded[2]).toEqual({ role: 'user', content: 'follow up' });
  });

  it('normalizes agent-role messages to assistant-role for the OpenAI schema', () => {
    const prior = 'Agent role content that should reach the model as assistant.';
    const bounded = buildBoundedMessagesForNat([
      { role: 'user', content: 'first question' },
      { role: 'agent', content: prior },
      { role: 'user', content: 'follow up' },
    ]);

    expect(bounded[1]).toEqual({ role: 'assistant', content: prior });
  });

  it('drops empty assistant messages (Bedrock rejects blank ContentBlock text)', () => {
    const bounded = buildBoundedMessagesForNat([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'follow up' },
    ]);

    expect(bounded).toHaveLength(2);
    expect(bounded.map((m) => m.role)).toEqual(['user', 'user']);
  });

  it('strips Daedalus-internal fields from outbound messages', () => {
    const bounded = buildBoundedMessagesForNat([
      {
        role: 'user',
        content: 'question',
        id: 'msg-1',
        attachments: [{ type: 'image', content: 'pic.png' }],
        metadata: { turnId: 't-1' },
      },
      {
        role: 'assistant',
        content: 'answer',
        intermediateSteps: [{ payload: { event_type: 'TOOL_END' } }],
        errorMessages: { message: 'x', timestamp: 1, recoverable: true },
      },
    ]);

    expect(bounded).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ]);
  });

  it('adds a documentRefs payload for multi-document attachments at the API boundary', () => {
    const message = {
      role: 'user',
      content: 'Ingest these docs',
      metadata: { targetCollection: 'nvidia' },
      attachments: [
        {
          type: 'document',
          content: 'a.md',
          documentRef: { documentId: 'doc-a', sessionId: 'sess-1' },
        },
        {
          type: 'document',
          content: 'b.md',
          documentRef: { documentId: 'doc-b', sessionId: 'sess-1' },
        },
      ],
    };

    const out = appendDocumentAttachmentContext(message, 'testuser');

    expect(out.content).toContain('documentRefs=');
    expect(out.content).toContain('"documentId":"doc-a"');
    expect(out.content).toContain('"filename":"a.md"');
    expect(out.content).toContain('username="testuser"');
    expect(out.content).toContain('collection_name="nvidia"');
    expect(out.content).toContain('collection_scope="shared"');
  });

  it('does not duplicate an existing documentRefs payload', () => {
    const content =
      'Use this documentRefs parameter: [{"documentId":"doc-a","sessionId":"sess-1"}]';
    const message = {
      role: 'user',
      content,
      attachments: [
        {
          type: 'document',
          content: 'a.md',
          documentRef: { documentId: 'doc-a', sessionId: 'sess-1' },
        },
        {
          type: 'document',
          content: 'b.md',
          documentRef: { documentId: 'doc-b', sessionId: 'sess-1' },
        },
      ],
    };

    const out = appendDocumentAttachmentContext(message, 'testuser');

    expect(out.content).toBe(content);
  });

  it('detects and compacts document-ingestion messages', () => {
    const message = {
      role: 'user',
      content: 'Ingest these docs',
      metadata: { targetCollection: 'nvidia' },
      attachments: [
        {
          type: 'document',
          content: 'a.md',
          documentRef: { documentId: 'doc-a', sessionId: 'sess-1' },
        },
        {
          type: 'document',
          content: 'b.md',
          documentRef: { documentId: 'doc-b', sessionId: 'sess-1' },
        },
      ],
    };

    expect(isDocumentIngestionRequest([message])).toBe(true);

    const out = compactDocumentIngestionMessage(message, 'testuser');

    expect(out.content).toContain('Ingest 2 uploaded documents into the "nvidia" collection.');
    expect(out.content).not.toContain('documentRefs=');
    expect(out.content).not.toContain('documentRef=');
    expect(out.content).not.toContain('user_document_tool');
    expect(out.content).not.toContain('Document 1:');
    expect(out.content).not.toContain('[DOCUMENT_REFERENCE_1]');
  });

  it('builds a structured document-ingestion job from attachment refs', () => {
    const job = getDocumentIngestJobRequest([
      {
        role: 'user',
        content: 'Ingest these docs',
        metadata: { targetCollection: 'nvidia' },
        attachments: [
          {
            type: 'document',
            content: 'a.md',
            documentRef: { documentId: 'doc-a', sessionId: 'sess-1' },
          },
          {
            type: 'document',
            content: 'b.md',
            documentRef: { documentId: 'doc-b', sessionId: 'sess-1' },
          },
        ],
      },
    ], 'testuser');

    expect(job).toEqual(expect.objectContaining({
      documentRefs: [
        {
          documentId: 'doc-a',
          sessionId: 'sess-1',
          filename: 'a.md',
        },
        {
          documentId: 'doc-b',
          sessionId: 'sess-1',
          filename: 'b.md',
        },
      ],
      collectionName: 'nvidia',
      collectionScope: 'shared',
      provenance: expect.objectContaining({
        uploader: 'testuser',
        targetCollection: 'nvidia',
        collectionScope: 'shared',
        databaseName: 'default',
      }),
      username: 'testuser',
    }));
  });

  it('does not treat a plain follow-up as ingestion when the prior turn ingested docs', () => {
    const messages = [
      {
        role: 'user',
        content: 'Ingest these docs',
        metadata: { targetCollection: 'nvidia' },
        attachments: [
          {
            type: 'document',
            content: 'a.md',
            documentRef: { documentId: 'doc-a', sessionId: 'sess-1' },
          },
        ],
      },
      {
        role: 'assistant',
        content: 'Ingestion complete.',
      },
      {
        role: 'user',
        content: 'What were the main themes across those documents?',
      },
    ];

    expect(isDocumentIngestionRequest(messages)).toBe(false);
    expect(getDocumentIngestJobRequest(messages, 'testuser')).toBeNull();
  });

  it('still detects ingestion when the newest user message has document attachments', () => {
    const messages = [
      {
        role: 'user',
        content: 'Quick question.',
      },
      {
        role: 'assistant',
        content: 'Sure, what is it?',
      },
      {
        role: 'user',
        content: 'Ingest these docs',
        metadata: { targetCollection: 'nvidia' },
        attachments: [
          {
            type: 'document',
            content: 'a.md',
            documentRef: { documentId: 'doc-a', sessionId: 'sess-1' },
          },
        ],
      },
    ];

    expect(isDocumentIngestionRequest(messages)).toBe(true);
    expect(getDocumentIngestJobRequest(messages, 'testuser')).toEqual(expect.objectContaining({
      documentRefs: [
        { documentId: 'doc-a', sessionId: 'sess-1', filename: 'a.md' },
      ],
      collectionName: 'nvidia',
      collectionScope: 'shared',
      provenance: expect.objectContaining({
        uploader: 'testuser',
        targetCollection: 'nvidia',
        collectionScope: 'shared',
      }),
      username: 'testuser',
    }));
  });

  it('rejects explicit scope mismatches for shared ingestion targets', () => {
    expect(() => getDocumentIngestJobRequest([
      {
        role: 'user',
        content: 'Ingest this doc',
        metadata: { targetCollection: 'nvidia', collectionScope: 'user' },
        attachments: [
          {
            type: 'document',
            content: 'a.md',
            documentRef: { documentId: 'doc-a', sessionId: 'sess-1' },
          },
        ],
      },
    ], 'testuser')).toThrow('does not match');
  });

  it('runs document ingestion through the direct streaming ingest endpoint by default', async () => {
    mocks.resolve4.mockResolvedValue(['10.0.2.61']);
    mocks.fetchWithTimeout.mockResolvedValue({ ok: true, status: 200 });
    const fetchSpy = vi.fn(() => new Promise(() => {}) as any);
    vi.stubGlobal('fetch', fetchSpy);
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      value: fetchSpy,
    });
    const redisStore = new Map<string, any>();
    (jsonSetWithExpiry as any).mockImplementation(
      async (key: string, value: any) => {
        redisStore.set(key, value);
      },
    );
    (jsonGet as any).mockImplementation(async (key: string) => (
      redisStore.has(key) ? redisStore.get(key) : null
    ));

    const req = {
      method: 'POST',
      headers: { cookie: 'sid=current-session' },
      body: {
        messages: [
          {
            role: 'user',
            content: 'Ingest these docs',
            metadata: { targetCollection: 'nvidia' },
            attachments: [
              {
                type: 'document',
                content: 'a.md',
                documentRef: { documentId: 'doc-a', sessionId: 'sess-1' },
              },
            ],
          },
        ],
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

    try {
      await handler(req, res);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      vi.unstubAllGlobals();
    }

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'streaming',
    }));
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'http://10.0.2.61:8000/docs',
      expect.objectContaining({
        method: 'HEAD',
      }),
      2000,
    );
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalledWith(
      expect.stringContaining('/v1/workflow/async'),
      expect.anything(),
      expect.anything(),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://10.0.2.61:8000/v1/documents/ingest/stream',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-user-id': 'testuser',
        }),
      }),
    );

    const storedJobRequest = (jsonSetWithExpiry as any).mock.calls.find(
      ([key]: [string]) => key.includes('async-job-request'),
    )?.[1];
    expect(storedJobRequest.executionMode).toBe('document_ingest');
    expect(storedJobRequest.natMessages).toEqual([]);
    expect(storedJobRequest.documentIngest).toEqual(expect.objectContaining({
      documentRefs: [
        {
          documentId: 'doc-a',
          sessionId: 'sess-1',
          filename: 'a.md',
        },
      ],
      collectionName: 'nvidia',
      collectionScope: 'shared',
      provenance: expect.objectContaining({
        uploader: 'testuser',
        targetCollection: 'nvidia',
        collectionScope: 'shared',
      }),
      username: 'testuser',
    }));

    const storedJobStatus = (jsonSetWithExpiry as any).mock.calls.find(
      ([key]: [string]) => key.includes('async-job-status'),
    )?.[1];
    expect(storedJobStatus.status).toBe('streaming');
    expect(storedJobStatus.progress).toBe(0);
    expect(storedJobStatus.ingestProgress).toEqual(expect.objectContaining({
      completed: 0,
      total: 1,
      percent: 0,
      phase: 'queued',
    }));

    const ingestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(ingestBody).toEqual(expect.objectContaining({
      documentRefs: [
        {
          documentId: 'doc-a',
          sessionId: 'sess-1',
          filename: 'a.md',
        },
      ],
      username: 'testuser',
      collection_name: 'nvidia',
      collection_scope: 'shared',
      provenance: expect.objectContaining({
        uploader: 'testuser',
        targetCollection: 'nvidia',
        collectionScope: 'shared',
      }),
    }));
  });

  it('can submit document ingestion through NAT async when the direct stream is disabled', async () => {
    process.env.DAEDALUS_DIRECT_DOCUMENT_INGEST_STREAM = '0';
    mocks.resolve4.mockResolvedValue(['10.0.2.61']);
    mocks.fetchWithTimeout
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn() });
    const redisStore = new Map<string, any>();
    (jsonSetWithExpiry as any).mockImplementation(
      async (key: string, value: any) => {
        redisStore.set(key, value);
      },
    );
    (jsonGet as any).mockImplementation(async (key: string) => (
      redisStore.has(key) ? redisStore.get(key) : null
    ));

    const req = {
      method: 'POST',
      headers: { cookie: 'sid=current-session' },
      body: {
        messages: [
          {
            role: 'user',
            content: 'Ingest these docs',
            metadata: { targetCollection: 'nvidia' },
            attachments: [
              {
                type: 'document',
                content: 'a.md',
                documentRef: { documentId: 'doc-a', sessionId: 'sess-1' },
              },
            ],
          },
        ],
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'http://10.0.2.61:8000/v1/workflow/async',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-user-id': 'testuser',
        }),
      }),
      45000,
    );
    const submitBody = JSON.parse(mocks.fetchWithTimeout.mock.calls[1][1].body);
    expect(submitBody.sync_timeout).toBe(0);
    expect(submitBody.messages[1].content).toContain('documentRef=');
    expect(submitBody.messages[1].content).toContain('collection_name="nvidia"');
    expect(submitBody.messages[1].content).toContain('collection_scope="shared"');

    const storedJobRequest = (jsonSetWithExpiry as any).mock.calls.find(
      ([key]: [string]) => key.includes('async-job-request'),
    )?.[1];
    expect(storedJobRequest.executionMode).toBe('nat_async');
    expect(storedJobRequest.natMessages[1].content).toContain('documentRef=');
  });

  it('runs normal chat turns through the streaming backend without submitting a NAT async job', async () => {
    mocks.resolve4.mockResolvedValue(['10.0.2.61']);
    mocks.fetchWithTimeout.mockResolvedValue({ ok: true, status: 200 });
    const fetchSpy = vi.fn(() => new Promise(() => {}) as any);
    vi.stubGlobal('fetch', fetchSpy);
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      value: fetchSpy,
    });
    const redisStore = new Map<string, any>();
    (jsonSetWithExpiry as any).mockImplementation(
      async (key: string, value: any) => {
        redisStore.set(key, value);
      },
    );
    (jsonGet as any).mockImplementation(async (key: string) => (
      redisStore.has(key) ? redisStore.get(key) : null
    ));

    const req = {
      method: 'POST',
      headers: { cookie: 'sid=current-session' },
      body: {
        conversationId: 'conv-1',
        messages: [
          {
            role: 'user',
            content: 'What is the status?',
          },
        ],
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

    try {
      await handler(req, res);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'http://10.0.2.61:8000/docs',
      expect.objectContaining({ method: 'HEAD' }),
      2000,
    );
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalledWith(
      expect.stringContaining('/v1/workflow/async'),
      expect.anything(),
      expect.anything(),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://10.0.2.61:8000/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-user-id': 'testuser',
        }),
      }),
    );

    const storedJobRequest = (jsonSetWithExpiry as any).mock.calls.find(
      ([key]: [string]) => key.includes('async-job-request'),
    )?.[1];
    expect(storedJobRequest.executionMode).toBe('stream');
    expect(storedJobRequest.natMessages[1].content).toBe('What is the status?');
  });

  it('routes follow-up messages through stream mode even when prior turns contained document ingestion', async () => {
    mocks.resolve4.mockResolvedValue(['10.0.2.61']);
    mocks.fetchWithTimeout.mockResolvedValue({ ok: true, status: 200 });
    const fetchSpy = vi.fn(() => new Promise(() => {}) as any);
    vi.stubGlobal('fetch', fetchSpy);
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      value: fetchSpy,
    });
    const redisStore = new Map<string, any>();
    (jsonSetWithExpiry as any).mockImplementation(
      async (key: string, value: any) => {
        redisStore.set(key, value);
      },
    );
    (jsonGet as any).mockImplementation(async (key: string) => (
      redisStore.has(key) ? redisStore.get(key) : null
    ));

    const req = {
      method: 'POST',
      headers: { cookie: 'sid=current-session' },
      body: {
        conversationId: 'conv-1',
        messages: [
          {
            role: 'user',
            content: 'Ingest these docs',
            metadata: { targetCollection: 'nvidia' },
            attachments: [
              {
                type: 'document',
                content: 'a.md',
                documentRef: { documentId: 'doc-a', sessionId: 'sess-1' },
              },
            ],
          },
          {
            role: 'assistant',
            content: 'Ingested 1 document into "nvidia".',
          },
          {
            role: 'user',
            content: 'Now tell me about the contents.',
          },
        ],
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

    try {
      await handler(req, res);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(res.status).toHaveBeenCalledWith(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://10.0.2.61:8000/v1/chat/completions',
      expect.anything(),
    );
    expect(fetchSpy).not.toHaveBeenCalledWith(
      'http://10.0.2.61:8000/v1/documents/ingest/stream',
      expect.anything(),
    );

    const storedJobRequest = (jsonSetWithExpiry as any).mock.calls.find(
      ([key]: [string]) => key.includes('async-job-request'),
    )?.[1];
    expect(storedJobRequest.executionMode).toBe('stream');
    expect(storedJobRequest.documentIngest).toBeUndefined();
  });

  it('sends prior assistant content verbatim through the full POST flow', async () => {
    mocks.resolve4.mockResolvedValue(['10.0.2.61']);
    mocks.fetchWithTimeout.mockResolvedValue({ ok: true, status: 200 });
    const fetchSpy = vi.fn(() => new Promise(() => {}) as any);
    vi.stubGlobal('fetch', fetchSpy);
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      value: fetchSpy,
    });
    const redisStore = new Map<string, any>();
    (jsonSetWithExpiry as any).mockImplementation(
      async (key: string, value: any) => {
        redisStore.set(key, value);
      },
    );
    (jsonGet as any).mockImplementation(async (key: string) => (
      redisStore.has(key) ? redisStore.get(key) : null
    ));

    const priorAssistant = 'The release notes show three new features and two bug fixes.';

    const req = {
      method: 'POST',
      headers: { cookie: 'sid=current-session' },
      body: {
        conversationId: 'conv-1',
        messages: [
          { role: 'user', content: 'Summarize the release notes.' },
          { role: 'assistant', content: priorAssistant, id: 'asst-1' },
          { role: 'user', content: 'Return your last response as a simple HTML file.' },
        ],
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

    try {
      await handler(req, res);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(res.status).toHaveBeenCalledWith(200);

    const storedJobRequest = (jsonSetWithExpiry as any).mock.calls.find(
      ([key]: [string]) => key.includes('async-job-request'),
    )?.[1];
    expect(storedJobRequest.executionMode).toBe('stream');

    const sentMessages = storedJobRequest.natMessages;
    expect(sentMessages[0].content).toContain('[IDENTITY]');
    expect(sentMessages.slice(1)).toEqual([
      { role: 'user', content: 'Summarize the release notes.' },
      { role: 'assistant', content: priorAssistant },
      { role: 'user', content: 'Return your last response as a simple HTML file.' },
    ]);

    const streamCall = fetchSpy.mock.calls.find(
      ([url]: [string]) => url.endsWith('/v1/chat/completions'),
    );
    expect(streamCall).toBeDefined();
    const streamPayload = JSON.parse(streamCall[1].body);
    expect(streamPayload.messages).toEqual(sentMessages);
  });

  it('treats legacy shared-service 404s as retryable instead of terminal', async () => {
    mocks.fetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await fetchNatJobStatus('job-legacy', {
      jobId: 'job-legacy',
      messages: [],
      additionalProps: {},
      userId: 'testuser',
    } as any);

    expect(result).toBeNull();
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'http://daedalus-backend-default.daedalus.svc.cluster.local:8000/v1/workflow/async/job/job-legacy',
      { headers: buildNatRequestHeaders('testuser') },
      30000,
    );
  });

  it('sanitizes a completed job fullResponse before returning cached status', async () => {
    const prior = 'Daily summary for May 13, 2026.';
    const next = 'The namespace is healthy.';
    const jobStatus = {
      jobId: 'job-123',
      status: 'completed',
      fullResponse: `${prior}\n\n${next}`,
      createdAt: 1,
      updatedAt: 2,
      finalizedAt: 3,
      conversationId: 'conv-1',
    };
    const jobRequest = {
      jobId: 'job-123',
      natBaseUrl: 'http://10.0.2.61:8000',
      messages: [
        { role: 'user', content: 'daily summary' },
        { role: 'assistant', content: prior },
        { role: 'user', content: 'namespace?' },
      ],
      additionalProps: {},
      userId: 'testuser',
      conversationId: 'conv-1',
    };
    (jsonGet as any)
      .mockResolvedValueOnce(jobStatus)
      .mockResolvedValueOnce(jobRequest)
      .mockResolvedValueOnce(jobStatus);
    (jsonSetWithExpiry as any).mockResolvedValue(undefined);
    const req = { method: 'GET', query: { jobId: 'job-123' } } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ...jobStatus,
      fullResponse: next,
      updatedAt: expect.any(Number),
    });
    expect(jsonSetWithExpiry).toHaveBeenCalledWith(
      'daedalus:async-job-status:job-123',
      {
        ...jobStatus,
        fullResponse: next,
        updatedAt: expect.any(Number),
      },
      3600,
    );
  });

  it('sanitizes a completed job fullResponse when the prior answer is appended', async () => {
    const prior = 'Daily summary for May 13, 2026.';
    const next = 'The namespace is healthy.';
    const jobStatus = {
      jobId: 'job-123',
      status: 'completed',
      fullResponse: `${next}\n\n${prior}`,
      createdAt: 1,
      updatedAt: 2,
      finalizedAt: 3,
      conversationId: 'conv-1',
    };
    const jobRequest = {
      jobId: 'job-123',
      natBaseUrl: 'http://10.0.2.61:8000',
      messages: [
        { role: 'user', content: 'daily summary' },
        { role: 'assistant', content: prior },
        { role: 'user', content: 'namespace?' },
      ],
      additionalProps: {},
      userId: 'testuser',
      conversationId: 'conv-1',
    };
    (jsonGet as any)
      .mockResolvedValueOnce(jobStatus)
      .mockResolvedValueOnce(jobRequest)
      .mockResolvedValueOnce(jobStatus);
    (jsonSetWithExpiry as any).mockResolvedValue(undefined);
    const req = { method: 'GET', query: { jobId: 'job-123' } } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ...jobStatus,
      fullResponse: next,
      updatedAt: expect.any(Number),
    });
  });

  it('sanitizes a streaming job partialResponse before returning cached status', async () => {
    const prior = 'Daily summary for May 13, 2026.';
    const next = 'The namespace is still healthy.';
    const jobStatus = {
      jobId: 'job-123',
      status: 'streaming',
      partialResponse: `${prior}\n\n${next}`,
      createdAt: 1,
      updatedAt: 2,
      conversationId: 'conv-1',
    };
    const jobRequest = {
      jobId: 'job-123',
      executionMode: 'stream',
      natBaseUrl: 'http://10.0.2.61:8000',
      messages: [
        { role: 'user', content: 'daily summary' },
        { role: 'assistant', content: prior },
        { role: 'user', content: 'namespace?' },
      ],
      additionalProps: {},
      userId: 'testuser',
      conversationId: 'conv-1',
    };
    (jsonGet as any)
      .mockResolvedValueOnce(jobStatus)
      .mockResolvedValueOnce(jobRequest)
      .mockResolvedValueOnce(jobStatus);
    (jsonSetWithExpiry as any).mockResolvedValue(undefined);
    const req = { method: 'GET', query: { jobId: 'job-123' } } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ...jobStatus,
      partialResponse: next,
      updatedAt: expect.any(Number),
    });
    expect(jsonSetWithExpiry).toHaveBeenCalledWith(
      'daedalus:async-job-status:job-123',
      {
        ...jobStatus,
        partialResponse: next,
        updatedAt: expect.any(Number),
      },
      3600,
    );
  });

  it('clears stale OAuth fields once a job is no longer oauth_required', async () => {
    const jobStatus = {
      jobId: 'job-123',
      status: 'streaming',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      oauthState: 'state-1',
      createdAt: 1,
      updatedAt: 2,
      conversationId: 'conv-1',
    };
    const jobRequest = {
      jobId: 'job-123',
      executionMode: 'stream',
      natBaseUrl: 'http://10.0.2.61:8000',
      messages: [{ role: 'user', content: 'check calendar' }],
      additionalProps: {},
      userId: 'testuser',
      conversationId: 'conv-1',
    };
    (jsonGet as any)
      .mockResolvedValueOnce(jobStatus)
      .mockResolvedValueOnce(jobRequest)
      .mockResolvedValueOnce(jobStatus);
    (jsonSetWithExpiry as any).mockResolvedValue(undefined);
    const req = { method: 'GET', query: { jobId: 'job-123' } } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ...jobStatus,
      authUrl: undefined,
      oauthState: undefined,
      updatedAt: expect.any(Number),
    });
    expect(jsonSetWithExpiry).toHaveBeenCalledWith(
      'daedalus:async-job-status:job-123',
      {
        ...jobStatus,
        authUrl: undefined,
        oauthState: undefined,
        updatedAt: expect.any(Number),
      },
      3600,
    );
  });

  it('rejects transcript attachments owned by another user before creating a job', async () => {
    (jsonGet as any).mockResolvedValueOnce({
      id: 'vtt-1',
      data: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello',
      mimeType: 'text/vtt',
      filename: 'meeting.vtt',
      size: 48,
      createdAt: Date.now(),
      sessionId: 'other-session',
      userId: 'other-user',
    });
    const req = {
      method: 'POST',
      headers: { cookie: 'sid=current-session' },
      body: {
        messages: [
          {
            role: 'user',
            content: 'summarize this transcript',
            attachments: [
              {
                type: 'transcript',
                vttRef: {
                  sessionId: 'other-session',
                  vttId: 'vtt-1',
                  filename: 'meeting.vtt',
                },
              },
            ],
          },
        ],
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'You do not have access to one of the transcript attachments.',
      reason: 'attachment_forbidden',
    });
    expect(jsonSetWithExpiry).not.toHaveBeenCalled();
  });

  it('finalizes stale stream jobs instead of leaving them pending forever', async () => {
    const now = 2_000_000_000_000;
    const staleAt = now - 16 * 60 * 1000;
    const jobStatus = {
      jobId: 'job-stale',
      status: 'pending',
      createdAt: staleAt,
      updatedAt: staleAt,
      conversationId: undefined,
    };
    const jobRequest = {
      jobId: 'job-stale',
      executionMode: 'stream',
      natBaseUrl: 'http://10.0.2.61:8000',
      messages: [],
      additionalProps: {},
      userId: 'testuser',
    };
    const finalizedStatus = {
      ...jobStatus,
      status: 'error',
      error: 'Backend stream did not produce an update before the timeout. Please try again.',
      partialResponse: '',
      intermediateSteps: [],
      updatedAt: now,
      finalizedAt: now,
    };
    (jsonGet as any)
      .mockResolvedValueOnce(jobStatus)
      .mockResolvedValueOnce(jobRequest)
      .mockResolvedValueOnce(jobStatus)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(jobStatus)
      .mockResolvedValueOnce(finalizedStatus);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const req = { method: 'GET', query: { jobId: 'job-stale' } } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

    try {
      await handler(req, res);
    } finally {
      nowSpy.mockRestore();
    }

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(finalizedStatus);
    expect(jsonSetWithExpiry).toHaveBeenCalledWith(
      'daedalus:async-job-abort:job-stale',
      true,
      3600,
    );
    expect(jsonSetWithExpiry).toHaveBeenCalledWith(
      'daedalus:async-job-status:job-stale',
      finalizedStatus,
      3600,
    );
  });
});

describe('chat/async response boundary helpers', () => {
  it('concatenates normal delta chunks without modification', () => {
    expect(
      extractAsyncStreamContentDelta(
        { choices: [{ delta: { content: 'hello ' } }] },
        '',
      ),
    ).toBe('hello ');
    expect(
      extractAsyncStreamContentDelta(
        { choices: [{ delta: { content: 'world' } }] },
        'hello ',
      ),
    ).toBe('world');
  });

  it('extracts only the new suffix from full-so-far message snapshots', () => {
    expect(
      extractAsyncStreamContentDelta(
        { choices: [{ message: { content: 'Daily summary for May 13, 2026.' } }] },
        '',
      ),
    ).toBe('Daily summary for May 13, 2026.');

    expect(
      extractAsyncStreamContentDelta(
        {
          choices: [{
            message: {
              content: 'Daily summary for May 13, 2026.\n\nThe namespace is healthy.',
            },
          }],
        },
        'Daily summary for May 13, 2026.',
      ),
    ).toBe('\n\nThe namespace is healthy.');
  });

  it('drops exact duplicate full-so-far snapshots', () => {
    expect(
      extractAsyncStreamContentDelta(
        { output: 'The same accumulated response.' },
        'The same accumulated response.',
      ),
    ).toBe('');
  });

  it('strips an exact prior assistant replay from the final output', () => {
    const prior =
      'Daily summary for May 13, 2026.\n\n' +
      '## 1. Date\nCurrent timestamp: 2026-05-13 15:26 UTC.';
    const next = 'The `nemotron-omni` namespace is healthy overall.';

    expect(
      stripReplayedAssistantPrefix(`${prior}\n\n${next}`, [
        { role: 'user', content: 'daily summary' },
        { role: 'assistant', content: prior },
        { role: 'user', content: 'check nemotron omni' },
      ]),
    ).toBe(next);
  });

  it('strips an exact prior assistant replay appended to the final output', () => {
    const prior =
      'Daily summary for May 13, 2026.\n\n' +
      '## 1. Date\nCurrent timestamp: 2026-05-13 15:26 UTC.';
    const next = 'The `nemotron-omni` namespace is healthy overall.';

    expect(
      stripReplayedAssistantPrefix(`${next}\n\n${prior}`, [
        { role: 'user', content: 'daily summary' },
        { role: 'assistant', content: prior },
        { role: 'user', content: 'check nemotron omni' },
      ]),
    ).toBe(next);
  });

  it('preserves responses that reference prior content without exact-prefix replay', () => {
    const prior = 'Daily summary for May 13, 2026.';
    const next = 'Compared with the prior daily summary, the namespace is now healthy.';

    expect(
      stripReplayedAssistantPrefix(next, [
        { role: 'assistant', content: prior },
        { role: 'user', content: 'compare the status' },
      ]),
    ).toBe(next);
  });

  it('preserves natural sentence prefixes that are not replay boundaries', () => {
    expect(
      stripReplayedAssistantPrefix('OK, here is the current status.', [
        { role: 'assistant', content: 'OK' },
        { role: 'user', content: 'status?' },
      ]),
    ).toBe('OK, here is the current status.');
  });
});
