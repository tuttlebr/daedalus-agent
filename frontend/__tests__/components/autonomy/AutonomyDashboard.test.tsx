import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import type { AutonomyConfig, AutonomyState } from '@/types/autonomy';

import { AutonomyDashboard } from '@/components/autonomy/AutonomyDashboard';

import { defaultConfig } from '@/server/autonomy/config';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let root: Root;
let container: HTMLDivElement;
let state: AutonomyState;
let config: AutonomyConfig;
beforeEach(() => {
  config = defaultConfig();
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
      json: async () => (url.endsWith('/config') ? config : state),
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
it('shows compact responsibilities and a single briefing without history or settings forms', async () => {
  await render();
  expect(container.textContent).toContain('Calendar');
  expect(container.textContent).toContain('Home');
  expect(container.textContent).toContain('18:00 Eastern');
  expect(container.textContent).toContain('No briefing yet.');
  expect(container.textContent).not.toContain(
    'Scheduled work and action history',
  );
  expect(container.querySelector('input[type=number]')).toBeNull();
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
  expect(container.textContent).toContain('Home · Partly completed');
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
  expect(container.textContent).not.toContain('No briefing yet.');
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
  expect(container.textContent).toContain('No automation enabled.');
});

function button(name: string) {
  const match = Array.from(container.querySelectorAll('button')).find(
    (node) =>
      node.getAttribute('aria-label') === name || node.textContent === name,
  );
  if (!match) throw new Error(`Missing button: ${name}`);
  return match;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function response(value: unknown) {
  return { ok: true, json: async () => value } as Response;
}
it('shows refresh progress until data arrives and confirms completion', async () => {
  await render();
  const pending = deferred<Response>();
  vi.mocked(fetch).mockImplementation(() => pending.promise);
  act(() => button('Refresh').click());
  expect(button('Refreshing…').disabled).toBe(true);
  expect(button('Refreshing…').getAttribute('aria-busy')).toBe('true');
  await act(async () => pending.resolve(response({ ...config, ...state })));
  expect(button('Refresh').disabled).toBe(false);
  expect(container.textContent).toContain('Up to date.');
});
it('distinguishes queueing from queued and running work, preventing duplicate checks', async () => {
  await render();
  const pending = deferred<Response>();
  vi.mocked(fetch).mockImplementation(async (url, options) =>
    options?.method === 'POST'
      ? pending.promise
      : response(String(url).endsWith('/config') ? config : state),
  );
  act(() => button('Check System health now').click());
  expect(button('Check System health now').textContent).toContain('Queueing…');
  state.actions.check = {
    id: 'check',
    kind: 'cluster_maintenance',
    responsibility: 'cluster',
    status: 'pending',
    dueAt: 0,
    createdAt: 0,
    updatedAt: 0,
    attempts: 0,
    payload: {},
    outcome: null,
  };
  await act(async () => pending.resolve(response({ id: 'check' })));
  expect(button('Check System health now').textContent).toBe('Queued');
  expect(button('Check System health now').disabled).toBe(true);
  state.actions.check.status = 'running';
  await act(async () => button('Refresh').click());
  expect(button('Check System health now').textContent).toBe('Working…');
  expect(button('Stop action').disabled).toBe(false);
});
it('retains the last good state on refresh failure and can recover', async () => {
  await render();
  vi.mocked(fetch).mockRejectedValue(new Error('offline'));
  await act(async () => button('Refresh').click());
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'last saved activity',
  );
  expect(button('Refresh').disabled).toBe(false);
  expect(container.textContent).toContain('Automations');
  vi.mocked(fetch).mockImplementation(async (url) =>
    response(String(url).endsWith('/config') ? config : state),
  );
  await act(async () => button('Refresh').click());
  expect(container.querySelector('[role=alert]')).toBeNull();
});
it('keeps only the newest briefing visible regardless of storage order', async () => {
  state.summaries = [1, 3, 2].map((n) => ({
    id: String(n),
    date: '2026-11-07',
    title: 'Daily summary',
    message: `Briefing number ${n}`,
    createdAt: n,
    items: [],
  }));
  await render();
  expect(container.textContent).toContain('Briefing number 3');
  expect(container.textContent).not.toContain('Briefing number 1');
  expect(container.textContent).not.toContain('Briefing number 2');
});
it('rejects a stale refresh started before a pause', async () => {
  await render();
  const oldRead = deferred<Response>();
  vi.mocked(fetch).mockImplementation(() => oldRead.promise);
  act(() => button('Refresh').click());
  const paused = { ...config, enabled: false };
  vi.mocked(fetch).mockImplementation(async (url) =>
    response(String(url).endsWith('/config') ? paused : state),
  );
  await act(async () => button('Pause all').click());
  await act(async () => oldRead.resolve(response({ ...config, ...state })));
  expect(button('Resume all')).toBeDefined();
  expect(container.textContent).toContain('Autonomy paused');
});
async function upload(patch: string, size = patch.length) {
  const input = container.querySelector('input[type=file]')!;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [{ name: 'automations.json', size, text: async () => patch }],
  });
  await act(async () =>
    input.dispatchEvent(new Event('change', { bubbles: true })),
  );
}
it('validates an uploaded patch before applying and retains it after a failed save', async () => {
  await render();
  await upload('{broken');
  expect(container.textContent).toContain('could not be read as JSON');
  await upload('{"responsibilities":{"cluster":{"intervalSeconds":0}}}');
  expect(container.textContent).toContain('Invalid autonomy setting');
  expect(container.textContent).not.toContain('Apply JSON');
  await upload('{"enabled":false}');
  expect(container.textContent).toContain('Ready to apply: automations.json');
  const pending = deferred<Response>();
  vi.mocked(fetch).mockImplementation(() => pending.promise);
  act(() => button('Apply JSON').click());
  expect(button('Applying JSON…').disabled).toBe(true);
  await act(async () => pending.resolve({ ok: false } as Response));
  expect(container.textContent).toContain('Ready to apply: automations.json');
  expect(button('Apply JSON').disabled).toBe(false);
  config.enabled = false;
  vi.mocked(fetch).mockImplementation(async (url) =>
    response(String(url).endsWith('/config') ? config : state),
  );
  await act(async () => button('Apply JSON').click());
  expect(container.textContent).toContain('Automation JSON applied.');
  expect(container.textContent).not.toContain('Ready to apply:');
  expect(button('Resume all')).toBeDefined();
});
it('rejects oversized files and unknown automation types without writes', async () => {
  await render();
  await upload('{}', 129 * 1024);
  expect(container.textContent).toContain('smaller than 128 KB');
  await upload('{"responsibilities":{"shell":{"enabled":true}}}');
  expect(container.textContent).toContain('Invalid autonomy setting');
  expect(
    vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method),
  ).toBe(true);
});

it('shows one area at a time and makes the other controls reachable', async () => {
  await render();
  expect(container.querySelectorAll('article[aria-label]').length).toBe(1);
  expect(
    container.querySelector('article[aria-label="System health"]'),
  ).not.toBeNull();
  act(() => button('Calendar').click());
  expect(
    container.querySelector('article[aria-label="System health"]'),
  ).toBeNull();
  expect(button('Check Calendar now').disabled).toBe(false);
  expect(button('Calendar').getAttribute('aria-pressed')).toBe('true');
});
it('pages pending ideas independently of daily summaries and hides reviewed ideas', async () => {
  state.proposals = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      `idea-${index}`,
      {
        id: `idea-${index}`,
        title: `Idea ${index}`,
        benefit: 'Less effort',
        trigger: 'Recurring',
        requiredAccess: 'Existing access',
        actions: 'Review evidence',
        limits: 'Within scope',
        status: index === 7 ? 'dismissed' : 'proposed',
        updatedAt: index,
      },
    ]),
  );
  await render();
  expect(container.textContent).toContain('Idea 6');
  expect(container.textContent).not.toContain('Idea 7');
  expect(container.textContent).not.toContain('Idea 0');
  expect(button('Previous ideas').disabled).toBe(true);
  act(() => button('More ideas').click());
  expect(container.textContent).toContain('Idea 3');
  act(() => button('More ideas').click());
  expect(container.textContent).toContain('Idea 0');
  expect(button('More ideas').disabled).toBe(true);
});
