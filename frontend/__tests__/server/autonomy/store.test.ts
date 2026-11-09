// @vitest-environment node
import { applyConfigPatch, defaultConfig } from '@/server/autonomy/config';
import {
  autonomyKey,
  cancelAction,
  reviewProposal,
  emptyState,
  getConfig,
  getState,
  requestResponsibility,
  saveConfig,
} from '@/server/autonomy/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  data: new Map<string, string>(),
  set: vi.fn(),
  publish: vi.fn(),
}));
vi.mock('@/server/session/redis', () => ({
  getRedis: () => ({
    get: async (key: string) => mock.data.get(key) || null,
    set: mock.set,
  }),
}));
vi.mock('@/utils/sync/publish', () => ({ publishSyncEvent: mock.publish }));
vi.mock('@/server/atomicJson', () => ({
  updateJsonAtomically: async (
    key: string,
    update: (v: unknown) => unknown,
  ) => {
    const next = await update(
      mock.data.has(key) ? JSON.parse(mock.data.get(key)!) : null,
    );
    if (next !== null) mock.data.set(key, JSON.stringify(next));
    return next;
  },
}));
beforeEach(() => {
  mock.data.clear();
  vi.clearAllMocks();
});

describe('strict charter config', () => {
  it.each([
    { mode: 'hybrid' },
    { sourcePolicy: {} },
    { intervalSeconds: 0 },
    { enabled: 'true' },
    { timezone: 'UTC' },
    { maxAttempts: 99 },
    { maxToolCalls: -1 },
    { responsibilities: { calendar: { sources: ['file:///private'] } } },
    {
      responsibilities: {
        calendar: { sources: ['https://user:secret@example.com'] },
      },
    },
    { responsibilities: { calendar: { reminderMinutes: [-1] } } },
    { responsibilities: { cluster: { intervalSeconds: 0 } } },
    { responsibilities: { lighting: { catchUpMinutes: 61 } } },
    { expansionPolicy: 'unrestricted' },
    null,
    [],
  ])(
    'rejects invalid settings without clamping or reviving legacy modes: %j',
    (patch) => {
      expect(() => applyConfigPatch(defaultConfig(), patch)).toThrow();
    },
  );
  it('merges one responsibility without resetting other settings', () => {
    const config = defaultConfig();
    config.responsibilities.calendar.calendarId = 'calendar';
    const next = applyConfigPatch(config, {
      responsibilities: { lighting: { enabled: false } },
    });
    expect(next.responsibilities.lighting.enabled).toBe(false);
    expect(next.responsibilities.calendar.calendarId).toBe('calendar');
    expect(config.responsibilities.lighting.enabled).toBe(true);
  });
});
it('reads only the new user-scoped config namespace', async () => {
  mock.data.set(
    'autonomy:alice:config',
    JSON.stringify({ mode: 'research_feed', enabled: false }),
  );
  expect((await getConfig('alice')).enabled).toBe(true);
  await saveConfig('alice', { enabled: false });
  expect((await getConfig('alice')).enabled).toBe(false);
  expect((await getConfig('bob')).enabled).toBe(true);
});
it('returns empty initial state and rejects malformed state', async () => {
  expect(await getState('alice')).toEqual(emptyState());
  mock.data.set(autonomyKey('alice', 'state'), '{"version":1}');
  await expect(getState('alice')).rejects.toThrow();
});
it('queues one existing responsibility and deduplicates another request', async () => {
  const id = await requestResponsibility('alice', 'cluster');
  expect(await requestResponsibility('alice', 'cluster')).toBe(id);
  const state = await getState('alice');
  expect(Object.values(state.actions)).toHaveLength(1);
  expect(state.actions[id].kind).toBe('cluster_maintenance');
  await expect(
    requestResponsibility('alice', 'arbitrary-shell-command'),
  ).rejects.toThrow();
});
it('rejects manual runs of paused responsibilities', async () => {
  await saveConfig('alice', {
    responsibilities: { calendar: { enabled: false } },
  });
  await expect(requestResponsibility('alice', 'calendar')).rejects.toThrow();
});
it('cancels pending work and signals running work without claiming its effects were undone', async () => {
  const id = await requestResponsibility('alice', 'cluster');
  expect(await cancelAction('alice', id)).toBe(true);
  expect((await getState('alice')).actions[id].status).toBe('cancelled');
  const state = await getState('alice');
  state.actions[id].status = 'running';
  state.actions[id].runId = 'run-one';
  mock.data.set(autonomyKey('alice', 'state'), JSON.stringify(state));
  expect(await cancelAction('alice', id)).toBe(true);
  expect(mock.set).toHaveBeenCalledWith(
    autonomyKey('alice', 'cancel:run-one'),
    '1',
    'EX',
    7200,
  );
  expect((await getState('alice')).actions[id].status).toBe('running');
  expect(await cancelAction('bob', id)).toBe(false);
});
it('retains dismissed proposal feedback in this user’s state', async () => {
  const state = emptyState();
  state.proposals.p = {
    id: 'p',
    title: 'New task',
    benefit: 'Helpful',
    trigger: 'Daily',
    requiredAccess: 'Calendar',
    actions: 'Prepare',
    limits: 'No sends',
    status: 'proposed',
    updatedAt: 0,
  };
  mock.data.set(autonomyKey('alice', 'state'), JSON.stringify(state));
  expect(await reviewProposal('alice', 'p', 'dismissed')).toBe(true);
  expect((await getState('alice')).proposals.p.status).toBe('dismissed');
  expect(await reviewProposal('alice', 'p', 'accepted')).toBe(true);
  const accepted = await getState('alice');
  expect(accepted.proposals.p.status).toBe('accepted');
  expect(accepted.actions).toEqual({});
  expect(await reviewProposal('alice', 'missing', 'dismissed')).toBe(false);
});

it.each(['pending', 'running'])(
  'preserves remote calendar identity when cancelling %s work',
  async (status) => {
    const state = emptyState();
    state.records.leaves = {
      externalId: 'google-event',
      observedState: { title: 'User title' },
    };
    state.actions.event = {
      id: 'event',
      kind: 'calendar_event',
      responsibility: 'calendar',
      status,
      dueAt: 0,
      createdAt: 0,
      updatedAt: 0,
      attempts: 1,
      runId: 'run-calendar',
      payload: { sourceKey: 'leaves' },
      outcome: null,
    };
    mock.data.set(autonomyKey('alice', 'state'), JSON.stringify(state));
    await cancelAction('alice', 'event');
    const saved = await getState('alice');
    expect(saved.records.leaves).toMatchObject({
      externalId: 'google-event',
      observedState: { title: 'User title' },
      dismissed: true,
    });
    expect(saved.actions.event.cancelledByUser).toBe(true);
    expect(saved.actions.event.status).toBe(
      status === 'running' ? 'running' : 'cancelled',
    );
  },
);

it('checks independent lighting rules once and respects their calendar windows', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(
    Date.parse('2026-11-08T12:00:00-05:00'),
  );
  try {
    await saveConfig('alice', {
      responsibilities: {
        lighting: {
          rules: [
            {
              id: 'sunday',
              title: 'Sunday lights',
              weekdays: [6],
              months: [11],
            },
            {
              id: 'monday',
              title: 'Monday lights',
              weekdays: [0],
              months: [11],
            },
          ],
        },
      },
    });
    await requestResponsibility('alice', 'lighting');
    await requestResponsibility('alice', 'lighting');
    const actions = Object.values((await getState('alice')).actions);
    expect(actions).toHaveLength(2);
    expect(actions.map((item) => item.payload.ruleId)).toEqual([
      undefined,
      'sunday',
    ]);
  } finally {
    vi.restoreAllMocks();
  }
});

it('reads old briefing configuration without returning unsupported settings', () => {
  const config = applyConfigPatch(defaultConfig(), {
    summary: { time: '18:00', destination: 'autonomy_dashboard' },
    maxSummariesStored: 90,
  });
  expect(config).not.toHaveProperty('summary');
  expect(config).not.toHaveProperty('maxSummariesStored');
});
