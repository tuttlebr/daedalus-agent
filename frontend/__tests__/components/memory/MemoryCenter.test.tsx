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
      (button) => button.textContent === 'Advanced Facts',
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

  it('shows page controls only when results span more than one page', async () => {
    const pageButtons = () =>
      Array.from(container.querySelectorAll('button')).filter((button) =>
        ['Previous', 'Next'].includes(button.textContent ?? ''),
      );
    items = [
      { id: 'world-1', text: 'World fact', fact_type: 'world', state: 'valid' },
    ];
    await showMemories();
    // The status line already reports the count of a single page.
    expect(container.textContent).toContain('1 remembered facts');
    expect(pageButtons()).toEqual([]);

    await act(async () => root.unmount());
    root = createRoot(container);
    items = Array.from({ length: 30 }, (_, index) => ({
      id: `world-${index}`,
      text: `World fact ${index}`,
      fact_type: 'world',
      state: 'valid',
    }));
    await showMemories();
    expect(pageButtons().map((button) => button.textContent)).toEqual([
      'Previous',
      'Next',
    ]);
    expect(container.textContent).toContain('Page 1 of 2');
  });

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

  function deferredResponse(body: unknown) {
    let resolve!: () => void;
    const promise = new Promise<{ ok: boolean; json: () => Promise<unknown> }>(
      (done) => {
        resolve = () => done({ ok: true, json: async () => body });
      },
    );
    return { promise, resolve };
  }

  function clickButton(label: string) {
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) =>
        candidate.textContent === label ||
        candidate.getAttribute('aria-label') === label,
    );
    expect(button).toBeDefined();
    return act(async () => button!.click());
  }

  it('refreshes the tab on screen after a mutation started on another tab', async () => {
    items = [
      {
        id: 'fact-1',
        text: 'Fact to forget',
        fact_type: 'world',
        state: 'valid',
      },
    ];
    const forget = deferredResponse({ state: 'invalidated' });
    const sources = deferredResponse({
      items: [{ id: 'source-from-chat', memory_unit_count: 2 }],
      total: 1,
      limit: 25,
      offset: 0,
    });
    const listMemories = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return forget.promise;
      if (url.startsWith('/api/memory/sources?')) return sources.promise;
      return listMemories(url, init);
    });
    await showMemories();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Forget memory"]')!
        .click();
    });
    await clickButton('Sources');
    await act(async () => forget.resolve());
    await act(async () => sources.resolve());

    expect(container.textContent).toContain('source-from-chat');
    expect(container.textContent).toContain('1 sources');
  });

  it('keeps a newer edit open when an earlier save finishes', async () => {
    items = [
      { id: 'fact-1', text: 'First fact', fact_type: 'world', state: 'valid' },
      { id: 'fact-2', text: 'Second fact', fact_type: 'world', state: 'valid' },
    ];
    const save = deferredResponse({ id: 'fact-1' });
    const listMemories = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? save.promise : listMemories(url, init),
    );
    await showMemories();
    const type = (text: string) =>
      act(async () => {
        const textarea = document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Memory text"]',
        )!;
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )!.set!.call(textarea, text);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });

    await act(async () => {
      card('First fact')
        .querySelector<HTMLButtonElement>('[aria-label="Edit memory"]')!
        .click();
    });
    await type('First fact, corrected');
    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Save memory')!
        .click();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close editor"]')!
        .click();
    });
    await act(async () => {
      card('Second fact')
        .querySelector<HTMLButtonElement>('[aria-label="Edit memory"]')!
        .click();
    });
    await type('Unsaved second draft');
    await act(async () => save.resolve());

    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Memory text"]',
      )?.value,
    ).toBe('Unsaved second draft');
  });
});
