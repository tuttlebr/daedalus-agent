import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';

import { describe, expect, it, vi } from 'vitest';

// The real viewer loads lazily; this stand-in has the same outer frame.
vi.mock('@/components/markdown/LazyCodeBlock', () => ({
  LazyCodeBlock: ({ value }: { value: string }) => (
    <div className="codeblock">
      <pre>
        <code>{value}</code>
      </pre>
    </div>
  ),
}));
vi.mock('@/components/markdown/LazyMermaidChart', () => ({
  LazyMermaidChart: ({ value }: { value: string }) => (
    <div className="codeblock" data-diagram={value} />
  ),
}));

function render(content: string) {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <MarkdownRenderer content={content} />,
  );
  return container;
}

describe('Markdown code frames', () => {
  it.each([
    ['fenced code', '```python\nprint("hi")\n```'],
    ['an indented block', '    print("hi")'],
    ['an HTML code block', '<pre><code>print("hi")</code></pre>'],
  ])('renders %s as one framed block', (_name, content) => {
    const container = render(content);
    const block = container.querySelector('.codeblock')!;
    expect(block).not.toBeNull();
    // The block owns its frame and scroller; no outer <pre> wraps it.
    expect(block.parentElement?.closest('pre')).toBeNull();
    expect(container.querySelectorAll('pre')).toHaveLength(1);
    expect(block.querySelector('code')?.textContent).toBe('print("hi")');
  });

  it('renders a diagram without a surrounding preformatted frame', () => {
    const container = render('```mermaid\ngraph LR\n A --> B\n```');
    const diagram = container.querySelector('[data-diagram]')!;
    expect(diagram.getAttribute('data-diagram')).toBe('graph LR\n A --> B');
    expect(diagram.closest('pre')).toBeNull();
  });

  it('keeps preformatted HTML text that is not code', () => {
    const container = render('<pre>\nfirst  line\n  second line\n</pre>');
    const pre = container.querySelector('pre')!;
    expect(pre.textContent).toContain('first  line\n  second line');
    expect(container.querySelector('.codeblock')).toBeNull();
  });
});
