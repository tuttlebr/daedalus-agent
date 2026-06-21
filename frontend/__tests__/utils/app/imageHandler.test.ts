import { cleanMessagesForLLM, uploadImage } from '@/utils/app/imageHandler';

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cleanMessagesForLLM document attachments', () => {
  it('adds a documentRefs JSON array for multi-document ingestion', () => {
    const [message] = cleanMessagesForLLM([
      {
        role: 'user',
        content: 'Ingest these documents',
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
    ]);

    expect(message.content).toContain(
      'Use this documentRefs parameter: documentRefs=[',
    );
    expect(message.content).toContain('"documentId":"doc-a"');
    expect(message.content).toContain('"filename":"a.md"');
    expect(message.content).toContain('these documents');
    expect(message.content).toContain('"nvidia" collection');
  });
});

describe('uploadImage', () => {
  it('uses the normalized MIME type returned by image storage', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        imageId: 'input-1',
        sessionId: 'session-1',
        userId: 'alice',
        mimeType: 'image/png',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const ref = await uploadImage('aGVpYw==', 'image/heic');

    expect(ref).toEqual({
      imageId: 'input-1',
      sessionId: 'session-1',
      userId: 'alice',
      mimeType: 'image/png',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      base64Data: 'aGVpYw==',
      mimeType: 'image/heic',
    });
  });
});
