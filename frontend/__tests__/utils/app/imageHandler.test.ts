import { describe, expect, it } from 'vitest';

import { cleanMessagesForLLM } from '@/utils/app/imageHandler';

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

    expect(message.content).toContain('Use this documentRefs parameter: documentRefs=[');
    expect(message.content).toContain('"documentId":"doc-a"');
    expect(message.content).toContain('"filename":"a.md"');
    expect(message.content).toContain('these documents');
    expect(message.content).toContain('"nvidia" collection');
  });
});
