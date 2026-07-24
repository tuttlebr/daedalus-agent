import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function renderMarkdown(content: string): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MarkdownRenderer content={content} />);
  });
  return { container, root };
}

describe('sandbox artifact Markdown links', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('uses an in-page download control instead of opening a blank tab', () => {
    const href =
      '/api/session/documentStorage?documentId=doc-1&sessionId=sandbox-session-1';
    const { container, root } = renderMarkdown(`[report.html](${href})`);
    const link = container.querySelector('a');

    expect(link?.getAttribute('href')).toBe(href);
    expect(link?.hasAttribute('download')).toBe(true);
    expect(link?.hasAttribute('target')).toBe(false);

    act(() => root.unmount());
  });

  it('keeps ordinary external links isolated in a new tab', () => {
    const { container, root } = renderMarkdown(
      '[source](https://example.com/report)',
    );
    const link = container.querySelector('a');

    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.hasAttribute('download')).toBe(false);

    act(() => root.unmount());
  });

  it('replaces a streamed link when final response metadata corrects its URL', () => {
    const firstHref =
      '/api/session/documentStorage?documentId=doc-old&sessionId=sandbox-session-1';
    const finalHref =
      '/api/session/documentStorage?documentId=doc-final&sessionId=sandbox-session-1';
    const { container, root } = renderMarkdown(`[report.html](${firstHref})`);

    act(() => {
      root.render(<MarkdownRenderer content={`[report.html](${finalHref})`} />);
    });

    expect(container.querySelector('a')?.getAttribute('href')).toBe(finalHref);

    act(() => root.unmount());
  });
});
