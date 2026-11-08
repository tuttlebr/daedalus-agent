import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import type { AutonomyState } from '@/types/autonomy';

import { AutonomyDashboard } from '@/components/autonomy/AutonomyDashboard';

import { defaultConfig } from '@/server/autonomy/config';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let root: Root;
let container: HTMLDivElement;
let state: AutonomyState;
beforeEach(() => {
  state = {
    version: 2,
    actions: {},
    schedules: {},
    records: {},
    proposals: {},
    notes: {},
    runs: [],
    summaries: [],
    reported: {},
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url.endsWith('/config') ? defaultConfig() : state),
    })),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => {
    root.render(<AutonomyDashboard />);
  });
}
it('shows the initial responsibilities and daily digest destination', async () => {
  await render();
  expect(container.textContent).toContain('Local calendar');
  expect(container.textContent).toContain('MSU game lighting');
  expect(container.textContent).toContain('18:00 Eastern');
  expect(container.textContent).toContain('Your first summary');
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
    '/api/autonomy/config',
    '/api/autonomy/state',
  ]);
});
it('reports partial lighting and skipped devices in a daily summary', async () => {
  state.summaries = [
    {
      id: 'one',
      date: '2026-11-07',
      title: 'Daily summary',
      message: '',
      createdAt: 0,
      items: [
        {
          responsibility: 'lighting',
          status: 'partial',
          summary: 'Reachable lights changed.',
          skipped: ['offline lamp'],
        },
      ],
    },
  ];
  await render();
  expect(container.textContent).toContain('lighting · partial');
  expect(container.textContent).toContain('offline lamp');
});
it('pauses all through the config API', async () => {
  await render();
  const button = Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent === 'Pause all',
  )!;
  await act(async () => button.click());
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(
        ([url, options]) =>
          url === '/api/autonomy/config' &&
          options?.body === '{"enabled":false}',
      ),
  ).toBe(true);
});
it('does not present a failed load as an empty successful dashboard', async () => {
  vi.mocked(fetch).mockRejectedValue(new Error('offline'));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'unavailable',
  );
  expect(container.textContent).not.toContain('Your first summary');
});

it('records useful-idea feedback without representing it as new action authority', async () => {
  const proposal = {
    id: 'idea',
    title: 'A useful idea',
    benefit: 'Saves effort',
    trigger: 'Daily',
    requiredAccess: 'Existing tools',
    actions: 'A proposed task',
    limits: 'Needs a defined charter',
    status: 'proposed' as const,
    updatedAt: 0,
  };
  state.proposals.idea = proposal;
  state.summaries = [
    {
      id: 'summary',
      date: '2026-11-07',
      title: 'Daily summary',
      message: '',
      createdAt: 0,
      items: [{ responsibility: 'evolution', status: 'proposed', proposal }],
    },
  ];
  await render();
  const button = Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent === 'Mark useful',
  )!;
  await act(async () => button.click());
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(
        ([url, options]) =>
          url === '/api/autonomy/state' &&
          options?.body === '{"operation":"accept","id":"idea"}',
      ),
  ).toBe(true);
  expect(container.textContent).toContain(
    'does not yet have permission to act',
  );
});
