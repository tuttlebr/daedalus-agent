import React from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react-dom/test-utils';

import { splitStreamingMarkdown } from '@/utils/app/streamingMarkdown';

import {
  RESPONSE_PROSE_CLASSES,
  ResponseDocument,
} from '@/components/chat/ResponseDocument';
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';

import { describe, expect, it, vi } from 'vitest';

const parsed = vi.hoisted(() => [] as string[]);

// Record every Markdown parse while rendering the real output.
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    default: (props: any) => {
      parsed.push(props.children);
      return createElement(actual.default as any, props);
    },
  };
});

function section(i: number): string {
  return [
    `## Step ${i}: inspect node pressure`,
    '',
    `The scheduler moved **${
      i * 3
    } pods** after \`memory.available<500Mi\`. See [the runbook](https://example.com/runbook/${i}).`,
    '',
    `- Node \`worker-${i}\` crossed its eviction threshold`,
    `- Requests exceed limits on ${i + 2} deployments`,
    '',
    '| Node | Memory | Evictions |',
    '| --- | --- | --- |',
    `| worker-${i} | 93% | ${i} |`,
    '',
    '```bash',
    `kubectl describe node worker-${i}`,
    '',
    `echo $$ # pid`,
    '```',
    '',
    `Raising the reservation by ${i * 128}Mi keeps daemons responsive.`,
    '',
  ].join('\n');
}

const EDGE_CASES = [
  // Loose lists, list continuations and code nested in list items.
  [
    '1. First step',
    '',
    '   Continued paragraph of step one.',
    '',
    '   ```python',
    '   print("a")',
    '',
    '   print("b")',
    '   ```',
    '',
    '2. Second step',
    '',
    '- bullet',
    '',
    '- loose bullet',
    '',
    '1984. starts like a list item',
  ].join('\n'),
  // Indented code with blank lines, tilde fences and thematic breaks.
  [
    'Intro paragraph.',
    '',
    '    indented code',
    '',
    '    more indented code',
    '',
    '~~~ js ~~~',
    'const a = 1;',
    '',
    '~~~',
    '',
    '***',
    '',
    '> quoted',
    '> text',
    '',
    '> another quote',
  ].join('\n'),
  // Display math, LaTeX delimiters and HTML that span blank lines.
  [
    'Energy:',
    '',
    '$$',
    'E = mc^2',
    '',
    '\\int_0^1 x\\,dx',
    '$$',
    '',
    '\\[',
    'a^2 + b^2',
    '',
    '= c^2',
    '\\]',
    '',
    '<!-- note',
    '',
    'still a comment -->',
    '',
    '<pre>',
    'pre text',
    '',
    'more pre',
    '</pre>',
    '',
    'After **all** of it.',
  ].join('\n'),
  // CRLF line endings and setext headings.
  'Title\r\n=====\r\n\r\nBody text\r\n\r\nSecond\r\n------\r\n\r\nEnd.',
];

const renderStreaming = (content: string) =>
  renderToStaticMarkup(
    <ResponseDocument
      document={{ kind: 'markdown', content }}
      messageIndex={0}
      messageId="m1"
      isStreaming
    />,
  );

// The single-pass streaming render this replaces.
const renderWhole = (content: string) =>
  renderToStaticMarkup(
    <MarkdownRenderer
      content={content}
      messageIndex={0}
      messageId="m1"
      className={RESPONSE_PROSE_CLASSES}
      allowHtml={false}
    />,
  );

function prefixes(text: string, step: number): string[] {
  const ends = new Set<number>();
  for (let end = step; end < text.length; end += step) ends.add(end);
  for (let index = 0; index < text.length; index += 1)
    if (text[index] === '\n') ends.add(index + 1);
  ends.add(text.length);
  return Array.from(ends)
    .sort((a, b) => a - b)
    .map((end) => text.slice(0, end));
}

describe('streaming Markdown rendering', () => {
  it('renders every prefix of an answer exactly like a single render', () => {
    let answer = '';
    for (let i = 1; answer.length < 3000; i += 1) answer += `${section(i)}\n`;
    for (const prefix of prefixes(answer, 23)) {
      expect(renderStreaming(prefix), JSON.stringify(prefix)).toBe(
        renderWhole(prefix),
      );
    }
  }, 60_000);

  it.each(EDGE_CASES.map((text, index) => [index, text]))(
    'keeps constructs that span blank lines intact (case %i)',
    (_index, text) => {
      for (const prefix of prefixes(text as string, 3)) {
        expect(renderStreaming(prefix), JSON.stringify(prefix)).toBe(
          renderWhole(prefix),
        );
      }
    },
  );

  it('splits only where later text cannot change earlier blocks', () => {
    expect(
      splitStreamingMarkdown('# A\n\nPara one.\n\nPara two.\n\nEnd'),
    ).toEqual(['# A\n\n', 'Para one.\n\n', 'Para two.\n\n', 'End']);
    // A list item can continue the list (or text) above it.
    expect(splitStreamingMarkdown('Items:\n\n- x\n\n- y\n\nEnd')).toEqual([
      'Items:\n\n- x\n\n- y\n\n',
      'End',
    ]);
    expect(splitStreamingMarkdown('```\na\n\nb')).toEqual(['```\na\n\nb']);
    expect(splitStreamingMarkdown('$$\nx\n\ny')).toEqual(['$$\nx\n\ny']);
    // References resolve across blocks, so such a document is not split.
    const references = 'See [docs][1].\n\nMore.\n\n[1]: https://example.com';
    expect(splitStreamingMarkdown(references)).toEqual([references]);
    expect(splitStreamingMarkdown('')).toEqual(['']);
  });

  it('parses only the growing tail while completed blocks are kept', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement('div'));
    const render = (content: string) =>
      act(() =>
        root.render(
          <ResponseDocument
            document={{ kind: 'markdown', content }}
            messageIndex={0}
            messageId="m1"
            isStreaming
          />,
        ),
      );
    const head =
      '## Plan\n\nFirst paragraph.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n';
    render(`${head}Tail`);
    parsed.length = 0;
    render(`${head}Tail grows`);
    expect(parsed).toEqual(['Tail grows']);

    parsed.length = 0;
    render(`${head}Tail grows.\n\nNext block`);
    expect(parsed).toEqual(['Tail grows.\n\n', 'Next block']);

    // The finished answer renders whole, through the full pipeline.
    parsed.length = 0;
    act(() =>
      root.render(
        <ResponseDocument
          document={{
            kind: 'markdown',
            content: `${head}Tail grows.\n\nNext block`,
          }}
          messageIndex={0}
          messageId="m1"
        />,
      ),
    );
    expect(parsed).toEqual([`${head}Tail grows.\n\nNext block`]);
    act(() => root.unmount());
  });
});
