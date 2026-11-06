import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ApiKeysPanel } from '@/components/connections/ApiKeysPanel';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock('@/utils/app/api', () => ({
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiDelete: mocks.apiDelete,
}));

vi.mock('@/components/primitives', () => ({
  Button: ({ children, isLoading, leftIcon, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  Input: (props: any) => <input {...props} />,
}));

vi.mock('@/components/surfaces', () => ({
  GlassCard: ({ children, variant, ...props }: any) => (
    <div {...props}>{children}</div>
  ),
}));

const key = {
  id: '0123456789abcdef',
  name: 'Laptop',
  prefix: 'dkey_01234567',
  createdAt: 1_700_000_000_000,
  lastUsedAt: null,
};

let root: Root;
let container: HTMLDivElement;

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ApiKeysPanel />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) =>
      candidate.textContent === label ||
      candidate.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`button ${label} not found`);
  return found as HTMLButtonElement;
}

beforeEach(() => {
  mocks.apiGet.mockResolvedValue({ enabled: true, maxKeys: 10, keys: [key] });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  mocks.apiGet.mockReset();
  mocks.apiPost.mockReset();
  mocks.apiDelete.mockReset();
});

describe('ApiKeysPanel', () => {
  it('lists key metadata and connection details without secrets', async () => {
    await render();
    expect(container.textContent).toContain('Laptop');
    expect(container.textContent).toContain('dkey_01234567');
    expect(container.textContent).toContain('/v1');
    expect(container.textContent).toContain('daedalus');
    expect(container.textContent).not.toContain('turned off');
  });

  it('explains when the server has API access disabled', async () => {
    mocks.apiGet.mockResolvedValue({ enabled: false, maxKeys: 10, keys: [] });
    await render();
    expect(container.textContent).toContain('API access is turned off');
    expect(container.textContent).toContain('No API keys yet.');
  });

  it('shows a new secret once and hides it when dismissed', async () => {
    await render();
    mocks.apiPost.mockResolvedValue({
      key: 'dkey_0123456789abcdef_secret',
      metadata: key,
    });
    const input = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, 'Editor');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    await flush();
    expect(mocks.apiPost).toHaveBeenCalledWith('/api/api-keys', {
      name: 'Editor',
    });
    expect(
      container.querySelector('[data-testid="api-key-secret"]')?.textContent,
    ).toBe('dkey_0123456789abcdef_secret');
    await act(async () => button('Done').click());
    expect(
      container.querySelector('[data-testid="api-key-secret"]'),
    ).toBeNull();
  });

  it('rotates and revokes after confirmation', async () => {
    await render();
    mocks.apiPost.mockResolvedValue({ key: 'dkey_new', metadata: key });
    await act(async () => button('Rotate Laptop').click());
    await flush();
    expect(mocks.apiPost).toHaveBeenCalledWith(
      '/api/api-keys/0123456789abcdef',
      { action: 'rotate' },
    );
    expect(container.textContent).toContain('dkey_new');

    mocks.apiDelete.mockResolvedValue({ revoked: true });
    await act(async () => button('Revoke Laptop').click());
    await flush();
    expect(mocks.apiDelete).toHaveBeenCalledWith(
      '/api/api-keys/0123456789abcdef',
    );

    vi.mocked(window.confirm).mockReturnValue(false);
    mocks.apiDelete.mockClear();
    await act(async () => button('Revoke Laptop').click());
    expect(mocks.apiDelete).not.toHaveBeenCalled();
  });

  it('shows server errors from key changes', async () => {
    await render();
    mocks.apiPost.mockRejectedValue({
      body: { error: 'You can have at most 10 API keys.' },
    });
    await act(async () => button('Rotate Laptop').click());
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'You can have at most 10 API keys.',
    );
  });
});
