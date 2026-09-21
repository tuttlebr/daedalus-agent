import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { MemoryCenter } from '@/components/memory/MemoryCenter';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: () => null,
}));

type MemoryItem = {
  id: string;
  text: string;
  fact_type?: string;
  type?: string;
  state: string;
};

describe('Memory Center curation', () => {
  let root: Root;
  let container: HTMLDivElement;
  let items: MemoryItem[];
  let mutationStatus: number;
  const fetchMock = vi.fn();

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    items = [];
    mutationStatus = 200;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (mutationStatus === 200) {
          const id = url.split('/').at(-2);
          items = items.filter((item) => item.id !== id);
        }
        return {
          ok: mutationStatus === 200,
          json: async () =>
            mutationStatus === 200
              ? { state: 'invalidated' }
              : { detail: 'Memory service rejected this request.' },
        };
      }
      if (url === '/api/memory/status') {
        return { ok: true, json: async () => ({ total: 0, counts: {} }) };
      }
      if (url === '/api/memory/pages') {
        return { ok: true, json: async () => ({ items: [], total: 0 }) };
      }
      if (url.startsWith('/api/memory/memories?')) {
        return {
          ok: true,
          json: async () => ({
            items,
            total: items.length,
            limit: 25,
            offset: 0,
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function showMemories() {
    await act(async () => root.render(<MemoryCenter />));
    const tab = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Advanced facts',
    );
    expect(tab).toBeDefined();
    await act(async () => tab!.click());
  }

  function card(text: string) {
    const paragraph = Array.from(container.querySelectorAll('p')).find(
      (element) => element.textContent === text,
    );
    expect(paragraph).toBeDefined();
    return paragraph!.parentElement!.parentElement!;
  }

  it('uses the list API fact_type and only offers curation for source facts', async () => {
    items = [
      { id: 'world-1', text: 'World fact', fact_type: 'world', state: 'valid' },
      {
        id: 'experience-1',
        text: 'Experience fact',
        fact_type: 'experience',
        state: 'valid',
      },
      {
        id: 'observation-1',
        text: 'Derived observation',
        fact_type: 'observation',
        state: 'valid',
      },
      { id: 'missing-1', text: 'Missing type', type: 'world', state: 'valid' },
      {
        id: 'unknown-1',
        text: 'Unknown type',
        fact_type: 'new',
        state: 'valid',
      },
    ];

    await showMemories();

    for (const text of ['World fact', 'Experience fact']) {
      expect(
        card(text).querySelector('[aria-label="Edit memory"]'),
      ).not.toBeNull();
      expect(
        card(text).querySelector('[aria-label="Forget memory"]'),
      ).not.toBeNull();
    }
    for (const text of [
      'Derived observation',
      'Missing type',
      'Unknown type',
    ]) {
      expect(card(text).querySelector('[aria-label="Edit memory"]')).toBeNull();
      expect(
        card(text).querySelector('[aria-label="Forget memory"]'),
      ).toBeNull();
    }
    expect(card('Derived observation').textContent).toContain('observation');
    expect(container.textContent).toContain(
      'Edit or forget the underlying facts to change this observation.',
    );
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it.each(['world', 'experience'])(
    'forgets a %s fact and refreshes the list',
    async (factType) => {
      items = [
        {
          id: 'fact-1',
          text: 'Fact to forget',
          fact_type: factType,
          state: 'valid',
        },
        {
          id: 'fact-2',
          text: 'Fact to keep',
          fact_type: 'world',
          state: 'valid',
        },
      ];
      await showMemories();

      await act(async () => {
        card('Fact to forget')
          .querySelector<HTMLButtonElement>('[aria-label="Forget memory"]')!
          .click();
      });

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/memory/memories/fact-1/invalidate',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            reason: 'user requested forget in Memory Center',
          }),
        }),
      );
      expect(container.textContent).not.toContain('Fact to forget');
      expect(container.textContent).toContain('Fact to keep');
      expect(container.textContent).toContain(
        'Memory forgotten and removed from future recall.',
      );
    },
  );

  it('keeps the fact visible and shows the backend error when forgetting fails', async () => {
    items = [
      {
        id: 'fact-1',
        text: 'Fact to keep',
        fact_type: 'world',
        state: 'valid',
      },
    ];
    mutationStatus = 400;
    await showMemories();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Forget memory"]')!
        .click();
    });

    expect(container.textContent).toContain('Fact to keep');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Memory service rejected this request.',
    );
    expect(container.textContent).not.toContain('Memory forgotten');
  });
});
