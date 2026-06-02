import { stripReplayedAssistantPrefix } from '@/utils/app/conversationReplay';

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
  parseIntermediateDataLine,
  resolveAsyncBackendBaseUrls,
} from '@/pages/api/chat/async';

import {
  clearStreamingState,
  jsonDel,
  jsonGet,
  jsonSetWithExpiry,
} from '@/server/session/redis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class MockDocumentRefAccessError extends Error {
    status: number;
    reason: string;

    constructor(status: number, message: string, reason: string) {
      super(message);
      this.name = 'DocumentRefAccessError';
      this.status = status;
      this.reason = reason;
    }
  }

  // Stable publisher singleton so .publish call history accumulates across the
  // many getPublisher() calls inside the stream reader + finalize paths.
  const publisher = { publish: vi.fn().mockResolvedValue(undefined) };

  return {
    resolve4: vi.fn(),
    fetchWithTimeout: vi.fn(),
    validateDocumentRefsForUser: vi.fn(async (refs: any[]) => refs),
    DocumentRefAccessError: MockDocumentRefAccessError,
    publisher,
    processMarkdownImages: vi.fn(async (s: string) => s),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('node:dns/promises', () => ({
  default: {
    resolve4: mocks.resolve4,
  },
  resolve4: mocks.resolve4,
}));

vi.mock('@/server/session/redis', () => ({
  getPublisher: vi.fn(() => mocks.publisher),
  getRedis: vi.fn(() => ({
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn().mockResolvedValue(1),
  })),
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  jsonDel: vi.fn().mockResolvedValue(0),
  setStreamingState: vi.fn().mockResolvedValue(undefined),
  clearStreamingState: vi.fn().mockResolvedValue(undefined),
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

vi.mock('@/server/session/documentRefs', () => ({
  validateDocumentRefsForUser: mocks.validateDocumentRefsForUser,
  DocumentRefAccessError: mocks.DocumentRefAccessError,
}));

// finalizeSuccess/finalizeError dynamically import these. Identity passthrough
// for image processing so output is asserted unchanged; web-push is stubbed so
// the (always-executed) dynamic import doesn't load the real native module.
vi.mock('@/utils/app/imageHandler', () => ({
  processMarkdownImages: mocks.processMarkdownImages,
}));

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: mocks.setVapidDetails,
    sendNotification: mocks.sendNotification,
  },
  setVapidDetails: mocks.setVapidDetails,
  sendNotification: mocks.sendNotification,
}));

describe('chat/async backend pinning helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateDocumentRefsForUser.mockImplementation(
      async (refs: any[]) => refs,
    );
    process.env.BACKEND_HOST = 'daedalus-backend';
    process.env.BACKEND_NAMESPACE = 'daedalus';
    process.env.BACKEND_PORT = '8000';
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    delete process.env.DEPLOYMENT_MODE;
    delete process.env.DAEDALUS_INTERNAL_API_TOKEN;
    delete process.env.DAEDALUS_DIRECT_DOCUMENT_INGEST_STREAM;
  });

  it('resolves pinned backend pod base URLs from the headless service', async () => {
    mocks.resolve4.mockResolvedValue(['10.0.2.61', '10.0.3.154', '10.0.2.61']);

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
    const nextTurn = buildNatSessionId(
      'testuser',
      'job-456',
      'conv-1',
      'turn-2',
    );

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
    const prior =
      'A detailed prior assistant response the user wants to reuse.';
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
    const prior =
      'Agent role content that should reach the model as assistant.';
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

  it('replaces a client-supplied documentRefs hint with the attachment refs', () => {
    const content =
      'Ingest these docs\n\n**Document References for Tools:**\n' +
      'Use this documentRefs parameter: documentRefs=[{"documentId":"untrusted","sessionId":"other"}]\n' +
      'Document 1: {"documentId":"untrusted","sessionId":"other"}';
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

    expect(out.content).not.toContain('untrusted');
    expect(out.content).toContain('documentRefs=');
    expect(out.content).toContain('"documentId":"doc-a"');
    expect(out.content).toContain('"documentId":"doc-b"');
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

    expect(out.content).toContain(
      'Ingest 2 uploaded documents into the "nvidia" collection.',
    );
    expect(out.content).not.toContain('documentRefs=');
    expect(out.content).not.toContain('documentRef=');
    expect(out.content).not.toContain('user_document_tool');
    expect(out.content).not.toContain('Document 1:');
    expect(out.content).not.toContain('[DOCUMENT_REFERENCE_1]');
  });

  it('builds a structured document-ingestion job from attachment refs', () => {
    const job = getDocumentIngestJobRequest(
      [
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
      ],
      'testuser',
    );

    expect(job).toEqual(
      expect.objectContaining({
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
      }),
    );
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
    expect(getDocumentIngestJobRequest(messages, 'testuser')).toEqual(
      expect.objectContaining({
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
      }),
    );
  });

  it('rejects explicit scope mismatches for shared ingestion targets', () => {
    expect(() =>
      getDocumentIngestJobRequest(
        [
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
        ],
        'testuser',
      ),
    ).toThrow('does not match');
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
    (jsonGet as any).mockImplementation(async (key: string) =>
      redisStore.has(key) ? redisStore.get(key) : null,
    );

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
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'streaming',
      }),
    );
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
    expect(storedJobRequest.documentIngest).toEqual(
      expect.objectContaining({
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
      }),
    );

    const storedJobStatus = (jsonSetWithExpiry as any).mock.calls.find(
      ([key]: [string]) => key.includes('async-job-status'),
    )?.[1];
    expect(storedJobStatus.status).toBe('streaming');
    expect(storedJobStatus.progress).toBe(0);
    expect(storedJobStatus.ingestProgress).toEqual(
      expect.objectContaining({
        completed: 0,
        total: 1,
        percent: 0,
        phase: 'queued',
      }),
    );

    const fetchCalls = fetchSpy.mock.calls as unknown as [
      string,
      RequestInit,
    ][];
    const ingestCall = fetchCalls[0];
    const ingestBody = JSON.parse(String(ingestCall[1]?.body ?? '{}'));
    expect(ingestBody).toEqual(
      expect.objectContaining({
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
      }),
    );
  });

  it('rejects document attachments that fail server-side ref validation', async () => {
    mocks.validateDocumentRefsForUser.mockRejectedValueOnce(
      new mocks.DocumentRefAccessError(
        403,
        'You do not have access to one of the document attachments.',
        'document_ref_forbidden',
      ),
    );

    const req = {
      method: 'POST',
      headers: { cookie: 'sid=current-session' },
      body: {
        messages: [
          {
            role: 'user',
            content: 'Ingest this doc',
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

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'You do not have access to one of the document attachments.',
      reason: 'document_ref_forbidden',
    });
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
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
    (jsonGet as any).mockImplementation(async (key: string) =>
      redisStore.has(key) ? redisStore.get(key) : null,
    );

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
    expect(submitBody.messages[1].content).toContain(
      'collection_name="nvidia"',
    );
    expect(submitBody.messages[1].content).toContain(
      'collection_scope="shared"',
    );

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
    (jsonGet as any).mockImplementation(async (key: string) =>
      redisStore.has(key) ? redisStore.get(key) : null,
    );

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

  it('injects a sanitized source policy after identity for NAT chat turns', async () => {
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
    (jsonGet as any).mockImplementation(async (key: string) =>
      redisStore.has(key) ? redisStore.get(key) : null,
    );

    const req = {
      method: 'POST',
      headers: { cookie: 'sid=current-session' },
      body: {
        conversationId: 'conv-1',
        additionalProps: {
          sourcePolicy: {
            enabledSources: ['curated_domains', 'missing'],
            disabledSources: ['google_search'],
            maxResearchToolCalls: 6,
            requirePlanApproval: true,
          },
        },
        messages: [
          {
            role: 'user',
            content: 'Research inference tooling.',
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
    const storedJobRequest = (jsonSetWithExpiry as any).mock.calls.find(
      ([key]: [string]) => key.includes('async-job-request'),
    )?.[1];
    expect(storedJobRequest.natMessages[0].content).toContain('[IDENTITY]');
    expect(storedJobRequest.natMessages[1].content).toContain(
      '[SOURCE_POLICY]',
    );
    expect(storedJobRequest.natMessages[1].content).toContain(
      'enabled_source_ids=["curated_domains"]',
    );
    expect(storedJobRequest.natMessages[1].content).toContain(
      'disabled_source_ids=["google_search"]',
    );
    expect(storedJobRequest.natMessages[2].content).toBe(
      'Research inference tooling.',
    );
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
    (jsonGet as any).mockImplementation(async (key: string) =>
      redisStore.has(key) ? redisStore.get(key) : null,
    );

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
    (jsonGet as any).mockImplementation(async (key: string) =>
      redisStore.has(key) ? redisStore.get(key) : null,
    );

    const priorAssistant =
      'The release notes show three new features and two bug fixes.';

    const req = {
      method: 'POST',
      headers: { cookie: 'sid=current-session' },
      body: {
        conversationId: 'conv-1',
        messages: [
          { role: 'user', content: 'Summarize the release notes.' },
          { role: 'assistant', content: priorAssistant, id: 'asst-1' },
          {
            role: 'user',
            content: 'Return your last response as a simple HTML file.',
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

    const storedJobRequest = (jsonSetWithExpiry as any).mock.calls.find(
      ([key]: [string]) => key.includes('async-job-request'),
    )?.[1];
    expect(storedJobRequest.executionMode).toBe('stream');

    const sentMessages = storedJobRequest.natMessages;
    expect(sentMessages[0].content).toContain('[IDENTITY]');
    expect(sentMessages.slice(1)).toEqual([
      { role: 'user', content: 'Summarize the release notes.' },
      { role: 'assistant', content: priorAssistant },
      {
        role: 'user',
        content: 'Return your last response as a simple HTML file.',
      },
    ]);

    const fetchCalls = fetchSpy.mock.calls as unknown as [
      string,
      RequestInit,
    ][];
    const streamCall = fetchCalls.find(([url]) =>
      url.endsWith('/v1/chat/completions'),
    );
    expect(streamCall).toBeDefined();
    if (!streamCall) throw new Error('Expected chat stream request');
    const streamPayload = JSON.parse(String(streamCall[1]?.body ?? '{}'));
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
      error:
        'Backend stream did not produce an update before the timeout. Please try again.',
      partialResponse: '',
      intermediateSteps: [],
      updatedAt: now,
      finalizedAt: now,
    };
    (jsonGet as any)
      .mockResolvedValueOnce(jobStatus)
      .mockResolvedValueOnce(jobRequest)
      // in-lock re-check before the stale finalizeError (finalizer-lock guard)
      .mockResolvedValueOnce(jobStatus)
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
        {
          choices: [
            { message: { content: 'Daily summary for May 13, 2026.' } },
          ],
        },
        '',
      ),
    ).toBe('Daily summary for May 13, 2026.');

    expect(
      extractAsyncStreamContentDelta(
        {
          choices: [
            {
              message: {
                content:
                  'Daily summary for May 13, 2026.\n\nThe namespace is healthy.',
              },
            },
          ],
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
    const next =
      'Compared with the prior daily summary, the namespace is now healthy.';

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

// ── Characterization tests for the streaming / finalize / cancel hot paths ──
// These drive the real handler with a finite fake SSE stream so the previously
// untested background reader, finalize, finalizer, OAuth and DELETE paths run
// end-to-end. They lock current behavior ahead of the F-003 decomposition.

// A finite, resolving fake of the backend stream Response. read() yields each
// scripted chunk (encoded) then {done:true}; the reader terminates naturally.
function makeSseResponse(
  chunks: string[],
  init: { ok?: boolean; status?: number } = {},
) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined },
        releaseLock: () => {},
        cancel: async () => {},
      }),
    },
  };
}

// Back jsonGet/jsonSetWithExpiry/jsonDel with an in-memory map (the existing
// pattern, factored out) so background writes are observable after draining.
function wireRedisStore(initial: Record<string, any> = {}) {
  const store = new Map<string, any>(Object.entries(initial));
  (jsonGet as any).mockImplementation(async (key: string) =>
    store.has(key) ? store.get(key) : null,
  );
  (jsonSetWithExpiry as any).mockImplementation(
    async (key: string, value: any) => {
      store.set(key, value);
    },
  );
  (jsonDel as any).mockImplementation(async (key: string) => {
    const had = store.delete(key);
    return had ? 1 : 0;
  });
  return store;
}

function stubFetch(impl: (...args: any[]) => any) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  Object.defineProperty(window, 'fetch', { configurable: true, value: spy });
  return spy;
}

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
}

// Flush the microtask/macrotask queue until `predicate` holds (background work
// done) or a tick budget is exhausted. The fake reader resolves immediately, so
// the whole chain settles within a few ticks.
async function drainUntil(
  predicate: () => boolean,
  maxTicks = 100,
): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function publishedEvents(): { channel: string; data: any }[] {
  return (mocks.publisher.publish as any).mock.calls.map(
    ([channel, payload]: [string, string]) => ({
      channel,
      data: JSON.parse(payload),
    }),
  );
}

function eventsOfType(type: string): any[] {
  return publishedEvents()
    .map((e) => e.data)
    .filter((d) => d && d.type === type);
}

// Drive one POST chat turn through the handler against a scripted SSE stream and
// (by default) wait until the background reader finalizes the job.
async function runStreamTurn(
  script: string[],
  opts: {
    messages?: any[];
    conversationId?: string | null;
    seedStore?: Record<string, any>;
    responseInit?: { ok?: boolean; status?: number };
    fetchImpl?: (...a: any[]) => any;
    expectNoFinalize?: boolean;
    drainPredicate?: () => boolean;
  } = {},
) {
  mocks.resolve4.mockResolvedValue(['10.0.2.61']);
  mocks.fetchWithTimeout.mockResolvedValue({ ok: true, status: 200 });
  const store = wireRedisStore(opts.seedStore);
  const conversationId =
    opts.conversationId === undefined ? 'conv-1' : opts.conversationId;
  const fetchSpy = stubFetch(
    opts.fetchImpl ?? (async () => makeSseResponse(script, opts.responseInit)),
  );
  const req = {
    method: 'POST',
    headers: { cookie: 'sid=current-session' },
    body: {
      ...(conversationId ? { conversationId } : {}),
      messages: opts.messages ?? [{ role: 'user', content: 'hello?' }],
    },
  } as any;
  const res = makeRes();
  try {
    await handler(req, res);
    const jobId = res.json.mock.calls[0]?.[0]?.jobId as string;
    const statusKey = `daedalus:async-job-status:${jobId}`;
    if (opts.drainPredicate) {
      await drainUntil(opts.drainPredicate);
    } else if (opts.expectNoFinalize) {
      await drainUntil(() => false, 15);
    } else {
      await drainUntil(() => Boolean(store.get(statusKey)?.finalizedAt));
    }
    return { jobId, store, res, fetchSpy, statusKey };
  } finally {
    vi.unstubAllGlobals();
  }
}

const TOKEN_CHANNEL = 'user:testuser:chat:conv-1:tokens';

describe('chat/async streaming + finalize (characterization)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateDocumentRefsForUser.mockImplementation(
      async (refs: any[]) => refs,
    );
    mocks.processMarkdownImages.mockImplementation(async (s: string) => s);
    mocks.publisher.publish.mockResolvedValue(undefined);
    mocks.sendNotification.mockResolvedValue(undefined);
    process.env.BACKEND_HOST = 'daedalus-backend';
    process.env.BACKEND_NAMESPACE = 'daedalus';
    process.env.BACKEND_PORT = '8000';
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    delete process.env.DEPLOYMENT_MODE;
    delete process.env.DAEDALUS_INTERNAL_API_TOKEN;
    delete process.env.DAEDALUS_DIRECT_DOCUMENT_INGEST_STREAM;
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  it('accumulates token deltas across reads and publishes chat_token per delta', async () => {
    const { statusKey, store } = await runStreamTurn([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
      'data: [DONE]\n',
    ]);

    const tokens = eventsOfType('chat_token');
    expect(tokens.map((t) => t.content)).toEqual(['Hel', 'lo']);
    expect(tokens.every((t) => t.conversationId === 'conv-1')).toBe(true);
    expect(
      (mocks.publisher.publish as any).mock.calls.some(
        ([channel]: [string]) => channel === TOKEN_CHANNEL,
      ),
    ).toBe(true);
    expect(store.get(statusKey)?.fullResponse).toBe('Hello');
  });

  it('finalizes to completed with the concatenated response after [DONE]', async () => {
    const { statusKey, store } = await runStreamTurn([
      'data: {"choices":[{"delta":{"content":"Done"}}]}\n',
      'data: [DONE]\n',
    ]);

    const status = store.get(statusKey);
    expect(status?.status).toBe('completed');
    expect(status?.fullResponse).toBe('Done');
    expect(status?.progress).toBe(100);
    expect(typeof status?.finalizedAt).toBe('number');

    const complete = eventsOfType('chat_complete');
    expect(complete).toHaveLength(1);
    expect(complete[0].fullResponse).toBe('Done');
  });

  it('parses intermediate_data frames, persists steps, and publishes chat_intermediate_step', async () => {
    const { statusKey, store } = await runStreamTurn([
      'intermediate_data: {"name":"Function Start: <search>","id":"s1","parent_id":"root","payload":"the query"}\n',
      'intermediate_data: {"name":"Function Complete: <search>","id":"s1","parent_id":"root","payload":"a result"}\n',
      'data: [DONE]\n',
    ]);

    const steps = eventsOfType('chat_intermediate_step');
    expect(steps).toHaveLength(2);
    expect(steps[0].step.payload.event_type).toBe('TOOL_START');
    expect(steps[1].step.payload.event_type).toBe('TOOL_END');

    const status = store.get(statusKey);
    expect(status?.status).toBe('completed');
    expect(status?.intermediateSteps).toHaveLength(2);
  });

  it('sanitizes completion-event step output against prior replay but leaves TOOL_END raw', async () => {
    const prior = 'Daily summary for May 13, 2026.';
    await runStreamTurn(
      [
        `intermediate_data: {"name":"Function Complete: <workflow>","id":"w1","parent_id":"root","payload":"${prior}\\n\\nWorkflow result."}\n`,
        `intermediate_data: {"name":"Function Complete: <search>","id":"t1","parent_id":"root","payload":"${prior}\\n\\nTool snippet."}\n`,
        'data: [DONE]\n',
      ],
      {
        messages: [
          { role: 'user', content: 'daily summary' },
          { role: 'assistant', content: prior },
          { role: 'user', content: 'run the workflow' },
        ],
      },
    );

    const steps = eventsOfType('chat_intermediate_step');
    const workflowEnd = steps.find(
      (s) => s.step.payload.event_type === 'WORKFLOW_END',
    );
    const toolEnd = steps.find((s) => s.step.payload.event_type === 'TOOL_END');
    expect(workflowEnd.step.payload.data.output).toBe('Workflow result.');
    expect(toolEnd.step.payload.data.output).toBe(`${prior}\n\nTool snippet.`);
  });

  it('promotes the last tool output when the stream produced no content tokens', async () => {
    const { statusKey, store } = await runStreamTurn([
      'intermediate_data: {"name":"Function Complete: <calc>","id":"t1","parent_id":"root","payload":"Preamble\\n**Function Output:**\\n```\\nThe answer is 42.\\n```"}\n',
      'data: [DONE]\n',
    ]);
    const status = store.get(statusKey);
    expect(status?.status).toBe('completed');
    expect(status?.fullResponse).toBe('The answer is 42.');
  });

  it('transitions to oauth_required then finalizes error when the stream closes without content', async () => {
    const { jobId, statusKey, store } = await runStreamTurn([
      'event: oauth_required\n',
      'data: {"auth_url":"https://accounts.google.com/auth","oauth_state":"xyz"}\n',
      'data: [DONE]\n',
    ]);

    const oauthUpdate = publishedEvents()
      .filter((e) => e.channel === `job:${jobId}:status`)
      .map((e) => e.data)
      .find((d) => d.status === 'oauth_required');
    expect(oauthUpdate).toBeDefined();
    expect(oauthUpdate.authUrl).toBe('https://accounts.google.com/auth');
    expect(oauthUpdate.oauthState).toBe('xyz');
    expect(oauthUpdate.progress).toBe(0);

    const status = store.get(statusKey);
    expect(status?.status).toBe('error');
    expect(status?.error).toContain('OAuth');
  });

  it('short-circuits without publishing or finalizing when the abort key is already set', async () => {
    mocks.resolve4.mockResolvedValue(['10.0.2.61']);
    mocks.fetchWithTimeout.mockResolvedValue({ ok: true, status: 200 });
    const store = wireRedisStore();
    (jsonGet as any).mockImplementation(async (key: string) => {
      if (key.includes('async-job-abort')) return true;
      return store.has(key) ? store.get(key) : null;
    });
    stubFetch(async () =>
      makeSseResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
        'data: [DONE]\n',
      ]),
    );
    const req = {
      method: 'POST',
      headers: { cookie: 'sid=current-session' },
      body: {
        conversationId: 'conv-1',
        messages: [{ role: 'user', content: 'go' }],
      },
    } as any;
    const res = makeRes();
    try {
      await handler(req, res);
      const jobId = res.json.mock.calls[0][0].jobId;
      await drainUntil(() => false, 15);
      expect(eventsOfType('chat_token')).toHaveLength(0);
      const status = store.get(`daedalus:async-job-status:${jobId}`);
      expect(status?.status).toBe('pending');
      expect(status?.finalizedAt).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('finalizes error when the backend stream responds non-ok', async () => {
    const { jobId, statusKey, store } = await runStreamTurn([], {
      responseInit: { ok: false, status: 502 },
    });
    const status = store.get(statusKey);
    expect(status?.status).toBe('error');
    expect(status?.error).toContain('Backend stream returned 502');
    expect(store.get(`daedalus:async-job-abort:${jobId}`)).toBe(true);
  });

  it('finalizes error and preserves accumulated steps when the reader throws mid-stream', async () => {
    let n = 0;
    const { statusKey, store } = await runStreamTurn([], {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        body: {
          getReader: () => ({
            read: async () => {
              n += 1;
              if (n === 1) {
                return {
                  done: false,
                  value: new TextEncoder().encode(
                    'intermediate_data: {"name":"Function Start: <x>","id":"a1","parent_id":"root","payload":"p"}\n',
                  ),
                };
              }
              throw new Error('socket reset');
            },
            releaseLock: () => {},
            cancel: async () => {},
          }),
        },
      }),
    });
    const status = store.get(statusKey);
    expect(status?.status).toBe('error');
    expect(status?.error).toContain('socket reset');
    expect(status?.intermediateSteps).toHaveLength(1);
  });

  it('finalizeSuccess saves the conversation, updates the selected conversation, and publishes chat_complete', async () => {
    const { jobId, statusKey, store } = await runStreamTurn(
      [
        'data: {"choices":[{"delta":{"content":"Answer."}}]}\n',
        'data: [DONE]\n',
      ],
      {
        conversationId: 'conv-1',
        seedStore: {
          'daedalus:user:testuser:selectedConversation': {
            id: 'conv-1',
            name: 'Old name',
            messages: [],
          },
        },
      },
    );

    const conversation = store.get('daedalus:conversation:conv-1');
    expect(conversation.messages).toHaveLength(2);
    const assistant = conversation.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBe('Answer.');
    expect(assistant.metadata.jobId).toBe(jobId);

    const selected = store.get('daedalus:user:testuser:selectedConversation');
    expect(selected.messages).toHaveLength(2);

    const complete = eventsOfType('chat_complete');
    expect(complete).toHaveLength(1);
    expect(complete[0].fullResponse).toBe('Answer.');

    expect(clearStreamingState).toHaveBeenCalledWith('testuser', 'conv-1');
    expect(store.get(statusKey)?.status).toBe('completed');
  });

  it('falls back to a placeholder when finalizing with no generated content', async () => {
    const { store } = await runStreamTurn(['data: [DONE]\n'], {
      conversationId: 'conv-1',
    });
    const conversation = store.get('daedalus:conversation:conv-1');
    expect(conversation.messages[1].content).toBe(
      '[No response was generated]',
    );
  });

  it('sends a push notification per subscription when VAPID keys are configured', async () => {
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'pub';
    process.env.VAPID_PRIVATE_KEY = 'priv';
    await runStreamTurn(
      ['data: {"choices":[{"delta":{"content":"Done"}}]}\n', 'data: [DONE]\n'],
      {
        conversationId: 'conv-1',
        seedStore: {
          'daedalus:user:testuser:push-subscriptions': [
            { endpoint: 'e1' },
            { endpoint: 'e2' },
          ],
        },
        drainPredicate: () =>
          (mocks.sendNotification as any).mock.calls.length >= 2,
      },
    );
    expect(mocks.setVapidDetails).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(2);
  });

  it('finalizeError saves a partial conversation with the error context', async () => {
    let n = 0;
    const { statusKey, store } = await runStreamTurn([], {
      conversationId: 'conv-1',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        body: {
          getReader: () => ({
            read: async () => {
              n += 1;
              if (n === 1) {
                return {
                  done: false,
                  value: new TextEncoder().encode(
                    'data: {"choices":[{"delta":{"content":"Partial answer."}}]}\n',
                  ),
                };
              }
              throw new Error('boom');
            },
            releaseLock: () => {},
            cancel: async () => {},
          }),
        },
      }),
    });

    const conversation = store.get('daedalus:conversation:conv-1');
    expect(conversation.isPartial).toBe(true);
    expect(conversation.error).toBe('boom');
    const assistant = conversation.messages[conversation.messages.length - 1];
    expect(assistant.content).toBe('Partial answer.');
    expect(assistant.errorMessages.message).toBe('boom');

    const status = store.get(statusKey);
    expect(status?.status).toBe('error');
    expect(status?.partialResponse).toBe('Partial answer.');
    expect(status?.error).toBe('boom');
  });

  it('finalizeError sanitizes the partial response against prior assistant replay', async () => {
    const prior = 'Daily summary for May 13, 2026.';
    let n = 0;
    const { statusKey, store } = await runStreamTurn([], {
      conversationId: 'conv-1',
      messages: [
        { role: 'user', content: 'daily summary' },
        { role: 'assistant', content: prior },
        { role: 'user', content: 'continue' },
      ],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        body: {
          getReader: () => ({
            read: async () => {
              n += 1;
              if (n === 1) {
                return {
                  done: false,
                  value: new TextEncoder().encode(
                    `data: {"choices":[{"delta":{"content":"${prior}\\n\\nNew partial."}}]}\n`,
                  ),
                };
              }
              throw new Error('boom');
            },
            releaseLock: () => {},
            cancel: async () => {},
          }),
        },
      }),
    });
    expect(store.get(statusKey)?.partialResponse).toBe('New partial.');
  });

  it('document ingest reports progress then finalizes success on the complete event', async () => {
    mocks.resolve4.mockResolvedValue(['10.0.2.61']);
    mocks.fetchWithTimeout.mockResolvedValue({ ok: true, status: 200 });
    const store = wireRedisStore();
    stubFetch(async () =>
      makeSseResponse([
        'event: progress\ndata: {"completed":1,"total":2,"percent":50,"current":"a.md"}\n\n',
        'event: complete\ndata: {"output":"Ingested 2 documents."}\n\n',
      ]),
    );
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
    const res = makeRes();
    try {
      await handler(req, res);
      const jobId = res.json.mock.calls[0][0].jobId;
      const statusKey = `daedalus:async-job-status:${jobId}`;
      await drainUntil(() => Boolean(store.get(statusKey)?.finalizedAt));
      const status = store.get(statusKey);
      expect(status?.status).toBe('completed');
      expect(status?.fullResponse).toBe('Ingested 2 documents.');
      const progressUpdate = publishedEvents()
        .filter((e) => e.channel === `job:${jobId}:status`)
        .map((e) => e.data)
        .find((d) => d.ingestProgress?.percent === 50);
      expect(progressUpdate).toBeDefined();
      expect(progressUpdate.ingestProgress.completed).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('document ingest finalizes error on an error event', async () => {
    mocks.resolve4.mockResolvedValue(['10.0.2.61']);
    mocks.fetchWithTimeout.mockResolvedValue({ ok: true, status: 200 });
    const store = wireRedisStore();
    stubFetch(async () =>
      makeSseResponse(['event: error\ndata: {"detail":"ingest exploded"}\n\n']),
    );
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
    const res = makeRes();
    try {
      await handler(req, res);
      const jobId = res.json.mock.calls[0][0].jobId;
      const statusKey = `daedalus:async-job-status:${jobId}`;
      await drainUntil(() => Boolean(store.get(statusKey)?.finalizedAt));
      const status = store.get(statusKey);
      expect(status?.status).toBe('error');
      expect(status?.error).toContain('ingest exploded');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('GET on a nat_async job finalizes completed when NAT reports success', async () => {
    const jobId = 'nat-success-1';
    const store = wireRedisStore({
      [`daedalus:async-job-status:${jobId}`]: {
        jobId,
        status: 'streaming',
        createdAt: 1,
        updatedAt: 2,
        conversationId: 'conv-1',
      },
      [`daedalus:async-job-request:${jobId}`]: {
        jobId,
        executionMode: 'nat_async',
        natBaseUrl: 'http://10.0.2.61:8000',
        messages: [{ role: 'user', content: 'hi' }],
        additionalProps: {},
        userId: 'testuser',
        conversationId: 'conv-1',
      },
    });
    mocks.fetchWithTimeout.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        job_id: jobId,
        status: 'success',
        error: null,
        output: { value: 'NAT answer.' },
        created_at: '',
        updated_at: '',
        expires_at: '',
      }),
    });
    const req = { method: 'GET', query: { jobId } } as any;
    const res = makeRes();
    await handler(req, res);
    await drainUntil(() =>
      Boolean(store.get(`daedalus:async-job-status:${jobId}`)?.finalizedAt),
    );
    const status = store.get(`daedalus:async-job-status:${jobId}`);
    expect(status?.status).toBe('completed');
    expect(status?.fullResponse).toBe('NAT answer.');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('GET on a nat_async job finalizes error when NAT reports failure', async () => {
    const jobId = 'nat-failure-1';
    const store = wireRedisStore({
      [`daedalus:async-job-status:${jobId}`]: {
        jobId,
        status: 'streaming',
        createdAt: 1,
        updatedAt: 2,
      },
      [`daedalus:async-job-request:${jobId}`]: {
        jobId,
        executionMode: 'nat_async',
        natBaseUrl: 'http://10.0.2.61:8000',
        messages: [],
        additionalProps: {},
        userId: 'testuser',
      },
    });
    mocks.fetchWithTimeout.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        job_id: jobId,
        status: 'failure',
        error: 'backend boom',
        output: null,
        created_at: '',
        updated_at: '',
        expires_at: '',
      }),
    });
    const req = { method: 'GET', query: { jobId } } as any;
    const res = makeRes();
    await handler(req, res);
    await drainUntil(() =>
      Boolean(store.get(`daedalus:async-job-status:${jobId}`)?.finalizedAt),
    );
    const status = store.get(`daedalus:async-job-status:${jobId}`);
    expect(status?.status).toBe('error');
    expect(status?.error).toContain('backend boom');
  });

  it('GET returns 404 without finalizing when the caller does not own the job', async () => {
    const jobId = 'owned-by-other';
    wireRedisStore({
      [`daedalus:async-job-status:${jobId}`]: {
        jobId,
        status: 'streaming',
        createdAt: 1,
        updatedAt: 2,
      },
      [`daedalus:async-job-request:${jobId}`]: {
        jobId,
        userId: 'attacker',
        messages: [],
        additionalProps: {},
      },
    });
    const req = { method: 'GET', query: { jobId } } as any;
    const res = makeRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('GET on a running nat_async job merges live steps and reports progress 50', async () => {
    vi.useFakeTimers();
    try {
      const jobId = 'nat-running-1';
      const store = wireRedisStore({
        [`daedalus:async-job-status:${jobId}`]: {
          jobId,
          status: 'pending',
          createdAt: 1,
          updatedAt: 2,
        },
        [`daedalus:async-job-request:${jobId}`]: {
          jobId,
          executionMode: 'nat_async',
          natBaseUrl: 'http://10.0.2.61:8000',
          messages: [],
          additionalProps: {},
          userId: 'testuser',
        },
        [`daedalus:async-job-steps:${jobId}`]: [
          { payload: { event_type: 'TOOL_START' } },
        ],
      });
      mocks.fetchWithTimeout.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          job_id: jobId,
          status: 'running',
          error: null,
          output: null,
          created_at: '',
          updated_at: '',
          expires_at: '',
        }),
      });
      const req = { method: 'GET', query: { jobId } } as any;
      const res = makeRes();
      const p = handler(req, res);
      await vi.advanceTimersByTimeAsync(0);
      await p;
      await vi.advanceTimersByTimeAsync(0);
      const status = store.get(`daedalus:async-job-status:${jobId}`);
      expect(status?.status).toBe('streaming');
      expect(status?.progress).toBe(50);
      expect(status?.intermediateSteps).toHaveLength(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('DELETE cancels an in-flight job, finalizes it, and cleans up', async () => {
    const jobId = 'del-1';
    const store = wireRedisStore({
      [`daedalus:async-job-request:${jobId}`]: {
        jobId,
        userId: 'testuser',
        conversationId: 'conv-1',
        messages: [{ role: 'user', content: 'hi' }],
      },
      [`daedalus:async-job-status:${jobId}`]: {
        jobId,
        status: 'streaming',
        partialResponse: 'partial',
        createdAt: 1,
        updatedAt: 2,
      },
      [`daedalus:async-job-steps:${jobId}`]: [
        { payload: { event_type: 'TOOL_END' } },
      ],
    });
    const req = { method: 'DELETE', query: { jobId } } as any;
    const res = makeRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ success: true, canceled: true });
    expect(store.get(`daedalus:async-job-abort:${jobId}`)).toBe(true);
    const status = store.get(`daedalus:async-job-status:${jobId}`);
    expect(status?.status).toBe('error');
    expect(status?.error).toBe('Job canceled by user');
    expect(typeof status?.finalizedAt).toBe('number');
    expect(status?.intermediateSteps).toHaveLength(1);
    expect(store.has(`daedalus:async-job-request:${jobId}`)).toBe(false);
    expect(store.has(`daedalus:async-job-steps:${jobId}`)).toBe(false);
    expect(clearStreamingState).toHaveBeenCalledWith('testuser', 'conv-1');
  });

  it('DELETE returns 404 and sets no abort flag for a job owned by another user', async () => {
    const jobId = 'del-other';
    const store = wireRedisStore({
      [`daedalus:async-job-request:${jobId}`]: {
        jobId,
        userId: 'attacker',
        messages: [],
      },
      [`daedalus:async-job-status:${jobId}`]: {
        jobId,
        status: 'streaming',
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const req = { method: 'DELETE', query: { jobId } } as any;
    const res = makeRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(store.get(`daedalus:async-job-abort:${jobId}`)).toBeUndefined();
  });

  it('DELETE on an already-finalized job leaves its status intact but still cleans up', async () => {
    const jobId = 'del-done';
    const store = wireRedisStore({
      [`daedalus:async-job-request:${jobId}`]: {
        jobId,
        userId: 'testuser',
        conversationId: 'conv-1',
        messages: [],
      },
      [`daedalus:async-job-status:${jobId}`]: {
        jobId,
        status: 'completed',
        fullResponse: 'done',
        finalizedAt: 123,
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const req = { method: 'DELETE', query: { jobId } } as any;
    const res = makeRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ success: true, canceled: true });
    const status = store.get(`daedalus:async-job-status:${jobId}`);
    expect(status?.status).toBe('completed');
    expect(status?.fullResponse).toBe('done');
    expect(store.has(`daedalus:async-job-request:${jobId}`)).toBe(false);
  });
});

describe('parseIntermediateDataLine', () => {
  it('maps a workflow completion to WORKFLOW_END with a cleaned name', () => {
    const step = parseIntermediateDataLine(
      JSON.stringify({
        name: 'Function Complete: <workflow>',
        id: 'w1',
        parent_id: 'root',
        payload: 'final',
      }),
    );
    expect(step.payload.event_type).toBe('WORKFLOW_END');
    expect(step.payload.name).toBe('workflow');
    expect(step.payload.data.output).toBe('final');
  });

  it('maps a function start to TOOL_START with payload as output', () => {
    const step = parseIntermediateDataLine(
      JSON.stringify({
        name: 'Function Start: <search>',
        id: 's1',
        parent_id: 'p1',
        payload: 'query',
      }),
    );
    expect(step.payload.event_type).toBe('TOOL_START');
    expect(step.payload.name).toBe('search');
    expect(step.parent_id).toBe('p1');
    expect(step.payload.data.output).toBe('query');
  });

  it('returns null for invalid JSON', () => {
    expect(parseIntermediateDataLine('{not json')).toBeNull();
  });

  it('falls back to root parent and a generated id when fields are missing', () => {
    const step = parseIntermediateDataLine(JSON.stringify({ name: 'Bare' }));
    expect(step.parent_id).toBe('root');
    expect(step.function_ancestry.node_id).toEqual(expect.any(String));
    expect(step.payload.UUID).toEqual(expect.any(String));
  });
});
