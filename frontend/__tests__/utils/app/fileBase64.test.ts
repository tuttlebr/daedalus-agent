import { base64Payload, readFileAsBase64 } from '@/utils/app/fileBase64';

import { describe, expect, it } from 'vitest';

describe('upload base64 payloads', () => {
  it.each([
    '',
    'application/octet-stream',
    'image/heic',
    'video/vnd.dlna.mpeg-tts',
  ])('reads a file typed %j as bare base64 of its bytes', async (type) => {
    const file = new File(['synthetic-image'], 'IMG_001.HEIC', { type });
    expect(await readFileAsBase64(file)).toBe(btoa('synthetic-image'));
  });

  it.each([
    'data:application/octet-stream;base64,',
    'data:;base64,',
    'data:image/svg+xml;charset=utf-8;base64,',
    'DATA:VIDEO/MP4;BASE64,',
  ])('removes a %s prefix', (prefix) => {
    expect(base64Payload(`${prefix}AAAA`)).toBe('AAAA');
  });

  it('leaves bare base64 unchanged', () => {
    expect(base64Payload('AAAA+/==')).toBe('AAAA+/==');
  });
});
