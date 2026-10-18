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
});
