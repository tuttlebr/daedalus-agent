import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { AutonomyFeedItem } from '@/types/autonomy';

import { FeedItem } from '@/components/autonomy/FeedItem';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('autonomy feed source links', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(sourceUrl: string) {
    const item = {
      id: 'item-1',
      lane: 'known',
      title: 'Finding',
      bluf: 'Summary',
      createdAt: Date.UTC(2026, 9, 1),
      sourceUrl,
    } as AutonomyFeedItem;
    act(() =>
      root.render(
        <FeedItem
          item={item}
          isExpanded={false}
          onToggle={() => {}}
          posinset={1}
          setsize={1}
          focused={false}
          registerRef={() => {}}
        />,
      ),
    );
    return container.querySelector('a');
  }

  it('links an http(s) source', () => {
    expect(render('https://example.test/report')?.getAttribute('href')).toBe(
      'https://example.test/report',
    );
  });

  it.each(['javascript:alert(document.cookie)', 'data:text/html,x', 'notes'])(
    'does not turn agent-written %s into a link',
    (sourceUrl) => {
      expect(render(sourceUrl)).toBeNull();
      expect(container.textContent).toContain('Finding');
    },
  );
});
