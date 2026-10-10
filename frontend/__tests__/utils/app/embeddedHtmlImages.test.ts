import { hasBoundedHtmlImages } from '@/utils/app/embeddedHtmlImages';
import {
  cleanMessagesForLLM,
  stripBase64Content,
} from '@/utils/app/imageHandler';

import { processMessages } from '@/server/chat/messagePreprocessing';
import {
  stripBase64FromObject,
  clampConversations,
} from '@/server/session/sanitize';
import { describe, expect, it } from 'vitest';

const photo =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nH0AAAAASUVORK5CYII=';
const html = `\`\`\`html\n<!doctype html><html><body><figure><img src="${photo}" alt="Source photo"><figcaption>Source caption</figcaption></figure><p>${'Article text. '.repeat(
  100,
)}</p></body></html>\n\`\`\``;

describe('embedded HTML photos', () => {
  it('preserves the exact assistant document through both storage cleaners and history', () => {
    const conversation = { messages: [{ role: 'assistant', content: html }] };
    const saved = stripBase64FromObject(stripBase64Content(conversation));
    expect(saved).toEqual(conversation);
    expect(clampConversations([saved])).toEqual([conversation]);
    expect(saved.messages[0].content).toContain(`src="${photo}"`);
  });

  it('omits image bytes only from the model copy and retains captions and the saved document', () => {
    const original = { role: 'assistant', content: html };
    const [context] = cleanMessagesForLLM([original]);
    expect(context.content).not.toContain('base64,');
    expect(context.content).toContain('Source caption');
    expect(original.content).toBe(html);
  });

  it('preserves existing user document preprocessing', () => {
    const [context] = cleanMessagesForLLM([
      {
        role: 'user',
        content: `<!-- DOCUMENT_EXTRACT_START -->Example ${photo}<!-- DOCUMENT_EXTRACT_END -->`,
      },
    ]);
    expect(context.content).toContain('--- Extracted Document Text ---');
    expect(context.content).toContain(photo);
    expect(context.content).not.toContain('DOCUMENT_EXTRACT_START');
  });

  it('keeps stripping attachments, user payloads and non-raster embedded data', () => {
    const message = {
      role: 'assistant',
      content: html,
      attachments: [{ content: photo }],
    };
    expect(stripBase64Content(message).attachments[0].content).toBe('');
    expect(stripBase64FromObject(message).attachments?.[0].content).toBe('');
    expect(
      stripBase64Content({ role: 'user', content: html }).content,
    ).not.toContain(photo);
    expect(
      hasBoundedHtmlImages(html.replace('image/png', 'image/svg+xml')),
    ).toBe(false);
    expect(hasBoundedHtmlImages(html.replace('image/png', 'text/html'))).toBe(
      false,
    );
    expect(hasBoundedHtmlImages(photo)).toBe(false);
  });

  it('omits image bytes from server-loaded model history without altering saved messages', async () => {
    const original = [{ role: 'assistant', content: html }];
    const [context] = await processMessages(
      original,
      'synthetic-session',
      'synthetic-user',
    );
    expect(context.content).not.toContain('base64,');
    expect(context.content).toContain('Source caption');
    expect(original[0].content).toBe(html);
  });

  it('bounds image count, individual images and complete document size', () => {
    expect(
      hasBoundedHtmlImages(
        `<article>${`<img src="${photo}">`.repeat(6)}</article>`,
      ),
    ).toBe(true);
    expect(
      hasBoundedHtmlImages(
        `<article>${`<img src="${photo}">`.repeat(7)}</article>`,
      ),
    ).toBe(false);
    expect(
      hasBoundedHtmlImages(
        html.replace(photo, `data:image/png;base64,${'A'.repeat(100_001)}`),
      ),
    ).toBe(false);
    expect(hasBoundedHtmlImages(html + ' '.repeat(2_000_001))).toBe(false);
  });
});
