import { stripBase64Content } from '@/utils/app/base64Content';

import { describe, expect, it } from 'vitest';

const photo =
  'data:image/png;base64,iVBORw0KGgoAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nH0AAAAASUVORK5CYII=';

describe('stripBase64Content', () => {
  it('keeps the prose around an embedded data URL in a long message', () => {
    const prose = 'Here is the reference image I mentioned. '.repeat(40);
    const cleaned = stripBase64Content({
      role: 'user',
      content: `${prose}![photo](${photo}) ${prose}`,
    });
    expect(cleaned.content).toContain(prose.trim());
    expect(cleaned.content).toContain('[base64 omitted]');
    expect(cleaned.content).not.toContain('base64,iVBOR');
  });

  it('blanks raw data URLs and leaves ordinary long text untouched', () => {
    const text = 'base64 is an encoding, not a payload. '.repeat(60);
    expect(stripBase64Content({ content: photo }).content).toBe('');
    expect(stripBase64Content({ content: text }).content).toBe(text);
  });

  it('recurses through nested records and arrays', () => {
    const cleaned = stripBase64Content({
      messages: [{ role: 'user', attachments: [{ content: photo }] }],
    });
    expect(cleaned.messages[0].attachments[0].content).toBe('');
  });
});
