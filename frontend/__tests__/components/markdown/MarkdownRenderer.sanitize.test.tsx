import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Model output is untrusted. The schema test checks configuration; this
// exercises the rendered result so removing the sanitizer from the
// pipeline fails as well.
describe('rendered model HTML sanitization', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('removes executable markup and keeps ordinary formatting', () => {
    const content = [
      'Safe **bold** text.',
      '',
      '<script>window.__xss = true</script>',
      '<img src="x" onerror="window.__xss = true" alt="probe">',
      '<a href="javascript:window.__xss=true">bad link</a>',
      '<iframe src="https://example.test"></iframe>',
      '<form action="https://example.test"><input name="q"></form>',
      '<p style="position:fixed">styled</p>',
      '<u>underlined</u>',
    ].join('\n');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<MarkdownRenderer content={content} />));

    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('u')?.textContent).toBe('underlined');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('form, input')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.querySelector('[style]')).toBeNull();
    for (const link of Array.from(container.querySelectorAll('a'))) {
      expect(link.getAttribute('href') || '').not.toMatch(/^javascript:/i);
    }
    expect((window as any).__xss).toBeUndefined();
    act(() => root.unmount());
  });

  it('drops application classes from model HTML but keeps renderer classes', () => {
    // The app's own utility classes would let model or tool HTML draw an
    // invisible full-screen link over the interface.
    const content = [
      '<a href="https://evil.test" class="fixed inset-0 z-50 opacity-0">overlay</a>',
      '<div class="fixed inset-0 bg-black">cover</div>',
      '<span class="sr-only absolute">hidden</span>',
      '',
      'Inline $$x^2$$ math.',
      '',
      '```python',
      'print(1)',
      '```',
    ].join('\n');
    const codeClasses: string[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <MarkdownRenderer
          content={content}
          components={{
            code: ({ className, children }) => {
              codeClasses.push(String(className));
              return <code>{children}</code>;
            },
          }}
        />,
      ),
    );

    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://evil.test',
    );
    for (const name of ['fixed', 'inset-0', 'z-50', 'opacity-0', 'absolute']) {
      expect(container.querySelector(`.${name}`)).toBeNull();
    }
    expect(container.querySelectorAll('.katex')).toHaveLength(1);
    expect(codeClasses).toContain('language-python');
    act(() => root.unmount());
  });
});
