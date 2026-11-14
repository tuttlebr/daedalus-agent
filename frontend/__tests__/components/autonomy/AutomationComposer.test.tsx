import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { AutomationComposer } from '@/components/autonomy/AutomationComposer';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const instructions =
  'Clean up pods across all Kubernetes namespaces where their status is "Completed"';
let root: Root;
let container: HTMLDivElement;
const apply = vi.fn(async () => true);

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  apply.mockClear();
  vi.stubGlobal('fetch', vi.fn());
  await act(async () =>
    root.render(
      <AutomationComposer
        busy={false}
        paused={false}
        lightingPaused={false}
        onApply={apply}
      />,
    ),
  );
  change('#automation-instructions', instructions);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function change(selector: string, value: string) {
  const field = container.querySelector(selector) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field),
      'value',
    )!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function preview() {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[type=submit]')!.click(),
  );
}

function retainedDraft() {
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
    instructions,
  );
  expect(
    container.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled,
  ).toBe(false);
  expect(container.textContent).not.toContain('Save automation');
  expect(apply).not.toHaveBeenCalled();
}

it.each([
  [
    502,
    'The planner returned an automation with invalid settings. Preview again.',
  ],
  [
    422,
    'This automation is blocked because pod deletion requires approval. Review the Kubernetes service permissions, then preview again.',
  ],
  [429, 'The automation planner is busy. Wait a moment, then preview again.'],
])(
  'shows the API reason for HTTP %i and retains the instructions',
  async (status, error) => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error }), { status }),
    );
    await preview();
    expect(container.querySelector('[role=alert]')?.textContent).toBe(error);
    retainedDraft();
  },
);

it('shows an intentional block with its reason without offering to save', async () => {
  const message =
    'Pod deletion requires interactive approval. Review the Kubernetes service permissions, then preview again.';
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ type: 'unsupported', message })),
  );
  await preview();
  expect(container.querySelector('[role=status]')?.textContent).toBe(
    `Automation blocked: ${message}`,
  );
  expect(container.querySelector('[role=alert]')).toBeNull();
  retainedDraft();
});

it.each([
  [401, 'Your session expired'],
  [429, 'Too many automation requests'],
  [502, 'HTTP 502'],
])(
  'handles non-JSON HTTP %i without displaying the response body',
  async (status, expected) => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('<html>private proxy diagnostics</html>', { status }),
    );
    await preview();
    expect(container.querySelector('[role=alert]')?.textContent).toContain(
      expected,
    );
    expect(container.textContent).not.toContain('private proxy');
    retainedDraft();
  },
);

it('identifies a network failure and preserves a clarification answer for retry', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        type: 'clarify',
        message: 'How often should cleanup run?',
      }),
    ),
  );
  await preview();
  change('#automation-answer', 'Every hour');
  vi.mocked(fetch).mockRejectedValueOnce(
    new TypeError('private network details'),
  );
  await preview();
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'Check your connection',
  );
  expect(container.textContent).not.toContain('private network');
  expect(
    container.querySelector<HTMLInputElement>('#automation-answer')?.value,
  ).toBe('Every hour');
  retainedDraft();
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        type: 'unsupported',
        message: 'Access is unavailable.',
      }),
    ),
  );
  await preview();
  expect(
    JSON.parse(vi.mocked(fetch).mock.calls[2][1]!.body as string).instructions,
  ).toContain('Every hour');
});

it('identifies a client timeout', async () => {
  vi.useFakeTimers();
  vi.mocked(fetch).mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  );
  await preview();
  await act(async () => vi.advanceTimersByTimeAsync(125000));
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'preview timed out',
  );
  retainedDraft();
});

it('clears an earlier savable preview when the next attempt fails', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        type: 'settings',
        responsibility: 'cluster',
        settings: { intervalSeconds: 3600 },
        baseRevision: 'one',
      }),
    ),
  );
  await preview();
  expect(container.textContent).toContain('Save automation');
  vi.mocked(fetch).mockResolvedValueOnce(new Response('not JSON'));
  await preview();
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'unreadable',
  );
  retainedDraft();
});
