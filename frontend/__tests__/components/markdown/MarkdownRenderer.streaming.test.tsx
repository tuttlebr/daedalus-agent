import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { isEqual } from '@/utils/data/isEqual';

import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/markdown/LazyCodeBlock', () => ({
  LazyCodeBlock: ({ language, value }: { language: string; value: string }) => (
    <pre data-language={language}>{value}</pre>
  ),
}));

describe('streamed Markdown updates', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([false, true])(
    'appends to a response whose earlier paragraphs contain inline markup (allowHtml=%s)',
    (allowHtml) => {
      let content =
        'Use **bold**, `code`, _emphasis_ and [a link](https://example.test).';
      act(() =>
        root.render(
          <MarkdownRenderer allowHtml={allowHtml} content={content} />,
        ),
      );
      for (const token of ['\n\nNext', ' paragraph', ' arrives.']) {
        content += token;
        act(() =>
          root.render(
            <MarkdownRenderer allowHtml={allowHtml} content={content} />,
          ),
        );
      }

      expect(container.querySelector('strong')?.textContent).toBe('bold');
      expect(container.querySelector('a')?.getAttribute('href')).toBe(
        'https://example.test',
      );
      expect(container.textContent).toContain('Next paragraph arrives.');
    },
  );

  it('compares React elements by what they render, not by their owner', () => {
    // React development builds record the rendering fiber on each element.
    // Successive renders use alternating fibers that refer to each other.
    const owner = { alternate: null as unknown };
    const alternate = { alternate: owner };
    owner.alternate = alternate;
    const first = {
      ...createElement('strong', { id: 'x' }, 'bold'),
      _owner: owner,
    };
    const second = {
      ...createElement('strong', { id: 'x' }, 'bold'),
      _owner: alternate,
    };

    expect(isEqual([first, ' text'], [second, ' text'])).toBe(true);
    expect(isEqual(first, createElement('strong', { id: 'y' }, 'bold'))).toBe(
      false,
    );
    expect(isEqual(first, createElement('em', { id: 'x' }, 'bold'))).toBe(
      false,
    );
  });

  it('updates the code language when a final answer corrects its fence', () => {
    for (const language of ['text', 'html']) {
      act(() =>
        root.render(
          <MarkdownRenderer
            content={`\`\`\`${language}\n<p>Report</p>\n\`\`\``}
          />,
        ),
      );
      expect(
        container
          .querySelector('[data-language]')
          ?.getAttribute('data-language'),
      ).toBe(language);
    }
  });
});
