import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';

import { describe, expect, it } from 'vitest';

function render(content: string, enableMath = true) {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <MarkdownRenderer
      content={content}
      enableMath={enableMath}
      components={{ code: ({ children }) => <code>{children}</code> }}
    />,
  );
  return container;
}

describe('rendered math and literal examples', () => {
  it('renders explicit inline LaTeX while preserving currency amounts', () => {
    const container = render('Price: $5 to $10. Formula: \\(x^2\\).');
    expect(container.querySelectorAll('.katex')).toHaveLength(1);
    expect(container.querySelector('.katex-display')).toBeNull();
    expect(container.textContent).toContain('Price: $5 to $10.');
    expect(container.querySelector('annotation')?.textContent).toBe('x^2');
  });

  it.each([
    '\\[x^2\\]',
    '\\begin{equation}x^2\\end{equation}',
    '\\begin{align}x &= 2\\end{align}',
  ])('renders display math for %s', (content) => {
    expect(render(content).querySelectorAll('.katex-display')).toHaveLength(1);
  });

  it.each([
    '`\\(x^2\\)`',
    '``literal ` and \\[x^2\\]``',
    '```latex\n\\[x^2\\]\n```',
    '~~~latex\n\\begin{align}x &= 2\\end{align}\n~~~',
    '    \\[x^2\\]',
    '<code>\\(x^2\\)</code>',
    '<pre><code>\\[x^2\\]</code></pre>',
    '```latex\n\\[x^2\\]',
    '> ```latex\n> \\[x^2\\]\n> ```',
    '- Example:\n\n  ```latex\n  \\[x^2\\]\n  ```',
  ])('preserves literal code when math is enabled: %s', (content) => {
    const literal = render(content, false);
    const withMath = render(content);
    expect(withMath.querySelector('code')).not.toBeNull();
    expect(withMath.querySelector('code')?.textContent).toBe(
      literal.querySelector('code')?.textContent,
    );
    expect(withMath.querySelector('.katex')).toBeNull();
  });

  it.each(['> \\[x^2\\]', '- \\[x^2\\]'])(
    'keeps display math within its Markdown container: %s',
    (content) => {
      const container = render(content);
      expect(
        container.querySelector('blockquote .katex-display, li .katex-display'),
      ).not.toBeNull();
    },
  );

  it('retains existing dollar math and the order of mixed delimiters', () => {
    const container = render('$$x^2$$ and \\(y^2\\) and \\[z^2\\]');
    expect(
      [...container.querySelectorAll('annotation')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['x^2', 'y^2', 'z^2']);
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1);
  });

  it('normalizes prose next to code without altering the example', () => {
    const container = render('Use `\\(x^2\\)` to write \\(x^2\\).');
    expect(container.querySelector('code')?.textContent).toBe('\\(x^2\\)');
    expect(container.querySelectorAll('.katex')).toHaveLength(1);
  });
});
