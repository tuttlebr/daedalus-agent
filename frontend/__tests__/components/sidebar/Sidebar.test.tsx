import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { Sidebar } from '@/components/sidebar/Sidebar';

import { useConversationStore } from '@/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiPut: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock('@/components/auth', () => ({
  useAuth: () => ({ logout: vi.fn() }),
}));
vi.mock('@/components/layout/AppearanceSettings', () => ({
  AppearanceSettings: () => null,
}));
vi.mock('@/utils/app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/app/api')>()),
  apiPut: mocks.apiPut,
  apiPost: mocks.apiPost,
  apiDelete: mocks.apiDelete,
}));

let root: Root;

const selectionWrites = () =>
  mocks.apiPut.mock.calls
    .filter(([path]) => path === '/api/session/selectedConversation')
    .map(([, body]) => body);

function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (candidate) =>
      candidate.getAttribute('aria-label') === name ||
      candidate.textContent?.trim() === name,
  );
  if (!match) throw new Error(`No button named ${name}`);
  return match as HTMLButtonElement;
}

describe('Sidebar conversation selection and rename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    sessionStorage.clear();
    mocks.apiPut.mockResolvedValue({ success: true, revision: 'saved' });
    mocks.apiPost.mockResolvedValue({ success: true });
    mocks.apiDelete.mockResolvedValue({ success: true });
    useConversationStore.setState({
      conversations: [
        {
          id: 'conv-a',
          name: 'First chat',
          folderId: null,
          messages: [],
          updatedAt: 2,
        },
        {
          id: 'conv-b',
          name: 'Second chat',
          folderId: null,
          messages: [],
          updatedAt: 1,
          revision: 'rev-b',
        } as any,
      ],
      selectedConversationId: 'conv-a',
      streamingConversationIds: new Set(),
    });
    root = createRoot(document.body.appendChild(document.createElement('div')));
    act(() => root.render(<Sidebar />));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  it('saves the conversation the user picks as the selection, by id', async () => {
    await act(async () => {
      button('Second chat').click();
    });

    expect(useConversationStore.getState().selectedConversationId).toBe(
      'conv-b',
    );
    expect(selectionWrites()).toEqual([{ id: 'conv-b' }]);
    expect(
      JSON.parse(sessionStorage.getItem('user:anon:selectedConversation')!),
    ).toEqual({ id: 'conv-b' });
  });

  it('selects a new chat and saves both the chat and the selection', async () => {
    await act(async () => {
      button('New Chat').click();
    });

    const { selectedConversationId } = useConversationStore.getState();
    expect(selectedConversationId).not.toMatch(/^conv-/);
    expect(selectionWrites()).toEqual([{ id: selectedConversationId }]);
    expect(mocks.apiPut).toHaveBeenCalledWith(
      `/api/conversations/${selectedConversationId}`,
      expect.objectContaining({ baseRevision: null }),
    );
  });

  it('does not save a reselection made because the selected chat was deleted', async () => {
    await act(async () => {
      document
        .getElementById('delete-conversation-conv-a')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      button('Confirm delete').click();
    });

    expect(mocks.apiDelete).toHaveBeenCalledWith('/api/conversations/conv-a');
    expect(useConversationStore.getState().selectedConversationId).toBe(
      'conv-b',
    );
    // Deletion removed the server pointer; it stays absent until the user
    // chooses a conversation.
    expect(selectionWrites()).toEqual([]);
  });

  it('offers the actions for each conversation from one menu button', () => {
    const more = document.getElementById('conversation-actions-conv-b')!;
    expect(more.getAttribute('aria-label')).toBe('Actions for Second chat');
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    const menu = document.getElementById(more.getAttribute('aria-controls')!)!;
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.getAttribute('popover')).toBe('auto');
    expect(more.getAttribute('popovertarget')).toBe(menu.id);
    expect(
      Array.from(menu.querySelectorAll('[role="menuitem"]')).map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(['Rename', 'Download Activity', 'Delete…']);
    // Navigation destinations are tabs, not repeated in the history footer.
    expect(
      Array.from(document.querySelectorAll('button')).map((b) =>
        b.textContent?.trim(),
      ),
    ).not.toEqual(expect.arrayContaining(['Memory Center', 'Connections']));
  });

  it.each([
    ['delete', 'delete-conversation-conv-b', 'Cancel delete'],
    ['rename', 'rename-conversation-conv-b', 'Cancel rename'],
  ])(
    'returns focus to the More button when a %s is canceled',
    async (_action, itemId, cancel) => {
      await act(async () => {
        document
          .getElementById(itemId)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await act(async () => {
        button(cancel).click();
      });
      // The More button returns with the row; focus moves on the next frame.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(document.activeElement?.id).toBe('conversation-actions-conv-b');
      expect(mocks.apiDelete).not.toHaveBeenCalled();
    },
  );

  it('saves a rename as a change to the name only', async () => {
    await act(async () => {
      document
        .getElementById('rename-conversation-conv-b')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Conversation name"]',
    )!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setValue.call(input, 'Renamed chat');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      button('Save name').click();
    });

    const [[, saved]] = mocks.apiPut.mock.calls.filter(
      ([path]) => path === '/api/conversations/conv-b',
    );
    // The server compares revisions; the copy's own clock is not consulted.
    expect(saved).toMatchObject({
      name: 'Renamed chat',
      baseRevision: 'rev-b',
    });
    expect(
      useConversationStore
        .getState()
        .conversations.find(({ id }) => id === 'conv-b')!.name,
    ).toBe('Renamed chat');
  });
});
