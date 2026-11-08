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

  it('extracts the fenced full-document daily-summary contract', () => {
    const html =
      '<!DOCTYPE html><html lang="en"><body><h1>Daedalus Daybook</h1></body></html>';

    expect(extractStandaloneHtmlResponse(`\`\`\`html\n${html}\n\`\`\``)).toBe(
      html,
    );
  });

  it('recovers a complete HTML document after leaked progress prose', () => {
    const html =
      '<!DOCTYPE html><html><body><h1>Daily Summary</h1></body></html>';
    const response = `I'll gather the live data first.\n${html}`;

    expect(extractStandaloneHtmlResponse(response)).toBe(html);
  });

  it('does not recover an incomplete embedded HTML document', () => {
    expect(
      extractStandaloneHtmlResponse(
        'Here is a partial document: <!DOCTYPE html><html><body>Draft',
      ),
    ).toBeNull();
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
