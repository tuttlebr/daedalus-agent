import { classifyResponseContent } from '@/components/chat/ResponseDocument';

import { describe, expect, it } from 'vitest';

describe('response document classification', () => {
  it('keeps standalone styled HTML on the HTML preview path', () => {
    const html =
      '<!doctype html><html><head><style>h1{color:red}</style></head><body><h1>Report</h1></body></html>';

    expect(classifyResponseContent(html)).toEqual({
      kind: 'html',
      content: html,
    });
  });

  it('unwraps a fenced Daybook document onto the HTML preview path', () => {
    const html =
      '<!DOCTYPE html><html><body><h1>Daedalus Daybook</h1></body></html>';

    expect(classifyResponseContent(`\`\`\`html\n${html}\n\`\`\``)).toEqual({
      kind: 'html',
      content: html,
    });
  });

  it('uses the Markdown renderer for long formatted responses', () => {
    const markdown = '# Report\n\n| A | B |\n| - | - |\n| 1 | 2 |';
    expect(classifyResponseContent(markdown)).toEqual({
      kind: 'markdown',
      content: markdown,
    });
  });

  it('can defer HTML preview classification while content is streaming', () => {
    const html = '<section><strong>Still streaming</strong></section>';
    expect(classifyResponseContent(html, false)).toEqual({
      kind: 'markdown',
      content: html,
    });
  });
});
