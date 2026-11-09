import configHandler from '@/pages/api/autonomy/config';
import stateHandler from '@/pages/api/autonomy/state';

import * as store from '@/server/autonomy/store';
import { enforceRateLimit } from '@/server/rateLimit';
import { requireAuthenticatedUser } from '@/server/session/_utils';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/server/autonomy/store', () => ({
  getState: vi.fn(),
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  requestResponsibility: vi.fn(),
  cancelAction: vi.fn(),
  reviewProposal: vi.fn(),
}));
vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: vi.fn(),
}));
vi.mock('@/server/rateLimit', () => ({
  enforceRateLimit: vi.fn(),
  ruleFromEnv: vi.fn(),
}));

function request(method: string, body: unknown = {}) {
  return {
    req: { method, body, query: { userId: 'victim' } } as any,
    res: {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAuthenticatedUser).mockResolvedValue({
    username: 'alice',
  } as any);
  vi.mocked(enforceRateLimit).mockResolvedValue(true);
  vi.mocked(store.getState).mockResolvedValue({
    version: 2,
    actions: {},
    proposals: {},
    schedules: {},
    records: {},
    notes: {},
    runs: [],
    summaries: [],
    reported: {},
  });
});

it.each([stateHandler, configHandler])(
  'requires authentication before reading or mutating',
  async (handler) => {
    vi.mocked(requireAuthenticatedUser).mockResolvedValue(null);
    for (const method of ['GET', 'POST', 'PUT']) {
      const { req, res } = request(method, {
        operation: 'run',
        responsibility: 'cluster',
      });
      await handler(req, res);
    }
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  },
);

it('reads only the authenticated account despite a caller-supplied user ID', async () => {
  const { req, res } = request('GET', { userId: 'victim' });
  await stateHandler(req, res);
  expect(store.getState).toHaveBeenCalledWith('alice');
  await configHandler(req, res);
  expect(store.getConfig).toHaveBeenCalledWith('alice');
});

it.each([
  [
    'run',
    'requestResponsibility',
    { responsibility: 'cluster' },
    'cluster',
    'action-id',
    202,
  ],
  ['cancel', 'cancelAction', { id: 'action' }, 'action', true, 200],
  ['dismiss', 'reviewProposal', { id: 'proposal' }, 'proposal', false, 404],
  ['accept', 'reviewProposal', { id: 'proposal' }, 'proposal', true, 200],
] as const)(
  'scopes %s to the session owner',
  async (operation, method, payload, argument, result, status) => {
    vi.mocked(store[method]).mockResolvedValue(result as never);
    const { req, res } = request('POST', {
      operation,
      ...payload,
      userId: 'victim',
    });
    await stateHandler(req, res);
    expect(store[method]).toHaveBeenCalledWith(
      'alice',
      argument,
      ...(method === 'reviewProposal'
        ? [operation === 'accept' ? 'accepted' : 'dismissed']
        : []),
    );
    expect(res.status).toHaveBeenCalledWith(status);
  },
);

it('does not dispatch when rate limited or when a legacy operation is supplied', async () => {
  vi.mocked(enforceRateLimit).mockResolvedValue(false);
  const { req, res } = request('POST', {
    operation: 'run',
    responsibility: 'cluster',
  });
  await stateHandler(req, res);
  expect(store.requestResponsibility).not.toHaveBeenCalled();
  vi.mocked(enforceRateLimit).mockResolvedValue(true);
  req.body = { operation: 'goal', prompt: 'legacy task' };
  await stateHandler(req, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(store.requestResponsibility).not.toHaveBeenCalled();
});

it('returns a bounded settings error without exposing stored secrets', async () => {
  vi.mocked(store.saveConfig).mockRejectedValue(
    new Error('PRIVATE_STORAGE_DETAIL'),
  );
  const { req, res } = request('PUT', { enabled: false });
  await configHandler(req, res);
  expect(store.saveConfig).toHaveBeenCalledWith('alice', { enabled: false });
  expect(res.status).toHaveBeenCalledWith(400);
  expect(JSON.stringify(res.json.mock.calls)).not.toContain(
    'PRIVATE_STORAGE_DETAIL',
  );
});

it('serves only current public notes, not stored briefings or diagnostics', async () => {
  vi.mocked(store.getState).mockResolvedValue({
    version: 2,
    actions: {},
    proposals: {},
    schedules: {},
    records: { private: 'DO_NOT_DELIVER' },
    notes: { cluster: 'DO_NOT_DELIVER' },
    runs: [],
    summaries: [
      {
        id: 'old',
        date: '2026-11-09',
        title: 'Latest briefing',
        message: 'DO_NOT_DELIVER',
        createdAt: 0,
        items: [],
      },
    ],
    reported: {},
  });
  const { req, res } = request('GET');
  await stateHandler(req, res);
  expect(store.getState).toHaveBeenCalledWith('alice');
  expect(res.json).toHaveBeenCalledWith({
    version: 2,
    actions: {},
    proposals: {},
    runningCount: 0,
    queuedCount: 0,
  });
  expect(JSON.stringify(res.json.mock.calls)).not.toContain('DO_NOT_DELIVER');
});
