import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/markdown/LazySearchResults', async () => {
  const { default: SearchResults } = await import(
    '@/components/markdown/SearchResults'
  );
  return { LazySearchResults: SearchResults };
});

describe('search result JSON in Markdown', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each(['', '\n'])(
    'preserves links and literal snippet text with %j padding',
    (padding) => {
      const link = 'https://example.test/one_two?q=a&b=雪';
      const title = '*Literal* source 雪';
      const snippet =
        'A <b>tag</b> &amp; and </searchresults> in provider text.';
      const payload = {
        query: 'Synthetic',
        organic_results: [{ title, link, snippet }],
      };
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      act(() =>
        root.render(
          <MarkdownRenderer
            content={`<searchresults>${padding}${JSON.stringify(
              payload,
            )}${padding}</searchresults>`}
          />,
        ),
      );
      const anchor = container.querySelector('a');
      expect(anchor?.getAttribute('href')).toBe(link);
      expect(anchor?.textContent).toBe(title);
      expect(container.textContent).toContain(snippet);
      expect(container.querySelector('b')).toBeNull();
      act(() => root.unmount());
    },
  );
});
