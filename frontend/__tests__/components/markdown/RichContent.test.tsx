import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';
import SearchResults from '@/components/markdown/SearchResults';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/markdown/LazyChart', async () => {
  const { default: Chart } = await import('@/components/markdown/Chart');
  return { LazyChart: Chart };
});
vi.mock('@/components/markdown/LazySearchResults', async () => {
  const { default: Results } = await import(
    '@/components/markdown/SearchResults'
  );
  return { LazySearchResults: Results };
});
vi.mock('html-to-image', () => ({ toBlob: vi.fn() }));
vi.mock('@/hooks/useFileSave', () => ({
  useFileSave: () => ({ saveFile: vi.fn(), fileSaveDialog: null }),
}));

const UNSAFE_LINKS = [
  'javascript:window.__xss=1',
  ' JaVaScRiPt:window.__xss=1',
  'data:text/html,<script>window.__xss=1</script>',
  'vbscript:msgbox(1)',
];

describe('rich model content', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // React logs caught render errors; the assertions below check the result.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    [
      'chart',
      '<chart>{"ChartType":"PieChart","Data":{"slice":1}}</chart>',
      'This chart could not be displayed.',
    ],
    [
      'search results',
      `<searchresults>${JSON.stringify({
        query: 'q',
        organic_results: [{ title: { nested: true }, link: 'https://a.test' }],
      })}</searchresults>`,
      'These search results could not be displayed.',
    ],
  ])(
    'keeps the rest of the message when a %s payload cannot render',
    (_kind, block, fallback) => {
      act(() =>
        root.render(
          <MarkdownRenderer
            content={['Before the block.', '', block, '', 'After it.'].join(
              '\n',
            )}
          />,
        ),
      );

      expect(container.textContent).toContain('Before the block.');
      expect(container.textContent).toContain('After it.');
      expect(container.textContent).toContain(fallback);
    },
  );

  it('only links search results to absolute http(s) URLs', () => {
    const unsafe = UNSAFE_LINKS[0];
    act(() =>
      root.render(
        <>
          {UNSAFE_LINKS.map((link) => (
            <SearchResults
              key={link}
              payload={{
                query: 'q',
                answer_box: { result: 'answer', link },
                knowledge_graph: {
                  title: 'kg',
                  website: link,
                  source_name: 'source',
                  source_link: link,
                  profiles: [{ name: 'profile', link }],
                },
                organic_results: [{ title: 'organic', link }],
                top_stories: [{ title: 'story', link }],
                news_results: [{ title: 'news', link }],
                images: [{ thumbnail: 'https://img.test/t.png', link }],
                shopping_results: [{ title: 'shop', link }],
                video_results: [{ title: 'video', link }],
                related_questions: [
                  { question: 'why', title: 'answer page', link },
                ],
              }}
            />
          ))}
          <SearchResults
            payload={{
              query: 'q',
              organic_results: [
                { title: 'safe', link: 'https://example.test/a?b=雪' },
                { title: 'relative', link: '/api/session/imageStorage' },
              ],
            }}
          />
        </>,
      ),
    );
    // Expand "People also ask" answers so their links are rendered too.
    act(() => {
      for (const button of Array.from(container.querySelectorAll('button')))
        if (button.textContent === 'why') button.click();
    });

    const hrefs = Array.from(container.querySelectorAll('a')).map((anchor) =>
      anchor.getAttribute('href'),
    );
    expect(hrefs).toContain('https://example.test/a?b=雪');
    expect(
      hrefs.filter((href) => href !== null && !/^https?:\/\//.test(href)),
    ).toEqual([]);
    expect(container.textContent).toContain('organic');
    expect(container.textContent).toContain('relative');
    expect(unsafe).toMatch(/^javascript:/);
  });
});
