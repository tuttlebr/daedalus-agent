import {
  extractStandaloneHtmlResponse,
  looksLikeStandaloneHtml,
} from '@/utils/app/htmlResponse';

import { describe, expect, it } from 'vitest';

describe('html response detection', () => {
  it('extracts full HTML documents', () => {
    const html =
      '<!doctype html><html><body><h1>Daily Summary</h1></body></html>';

    expect(extractStandaloneHtmlResponse(html)).toBe(html);
  });

  it('extracts fenced HTML blocks', () => {
    expect(
      extractStandaloneHtmlResponse('```html\n<div>Rendered</div>\n```'),
    ).toBe('<div>Rendered</div>');
  });

  it('detects common standalone HTML snippets', () => {
    expect(looksLikeStandaloneHtml('<section><p>Feed item</p></section>')).toBe(
      true,
    );
    expect(
      looksLikeStandaloneHtml('<img src="https://example.com/a.png" />'),
    ).toBe(true);
  });

  it('does not treat markdown as standalone HTML', () => {
    expect(extractStandaloneHtmlResponse('### Feed\n\n- Item one')).toBeNull();
    expect(
      extractStandaloneHtmlResponse('Here is <strong>inline</strong> HTML.'),
    ).toBeNull();
  });
});
