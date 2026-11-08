// @vitest-environment node
import handler from '@/pages/api/autonomy/plan';

import { defaultConfig } from '@/server/autonomy/config';
import { getConfig, saveAutomationPlan } from '@/server/autonomy/store';
import { enforceRateLimit } from '@/server/rateLimit';
import { requireAuthenticatedUser } from '@/server/session/_utils';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: vi.fn(),
}));
vi.mock('@/server/autonomy/store', () => ({
  getConfig: vi.fn(),
  saveAutomationPlan: vi.fn(),
}));
vi.mock('@/server/rateLimit', () => ({
  enforceRateLimit: vi.fn(),
  ruleFromEnv: vi.fn(),
}));
vi.mock('@/utils/app/backendApi', () => ({
  buildBackendBaseUrlForMode: () => 'http://backend:8000',
  buildBackendUrlFromBase: (base: string, path: string) => base + path,
}));
function call(
  method = 'POST',
  body: unknown = { instructions: 'Steelers lights on Sundays' },
) {
  return {
    req: { method, body, headers: { 'x-user-id': 'mallory' } } as any,
    res: {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as any,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAuthenticatedUser).mockResolvedValue({
    username: 'alice',
  } as any);
  vi.mocked(enforceRateLimit).mockResolvedValue(true);
  vi.mocked(getConfig).mockResolvedValue(defaultConfig());
  vi.stubEnv('DAEDALUS_INTERNAL_API_TOKEN', 'test-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    type: 'clarify',
                    message: 'At kickoff?',
                  }),
                },
              },
            ],
          }),
        ),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it('uses the signed-in identity and previews without saving', async () => {
  const { req, res } = call();
  await handler(req, res);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({
    type: 'clarify',
    message: 'At kickoff?',
  });
  expect(getConfig).toHaveBeenCalledWith('alice');
  expect(saveAutomationPlan).not.toHaveBeenCalled();
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe('http://backend:8000/internal/autonomy/plan');
  expect(init?.headers).toMatchObject({
    'x-user-id': 'alice',
    'x-daedalus-internal-token': 'test-token',
  });
  expect(init?.body).toContain('Steelers lights');
});
it('requires authentication and rate capacity before contacting the model', async () => {
  vi.mocked(requireAuthenticatedUser).mockResolvedValue(null);
  let request = call();
  await handler(request.req, request.res);
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(requireAuthenticatedUser).mockResolvedValue({
    username: 'alice',
  } as any);
  vi.mocked(enforceRateLimit).mockResolvedValue(false);
  request = call();
  await handler(request.req, request.res);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([{}, { instructions: '' }, { instructions: 'x'.repeat(4001) }])(
  'rejects invalid input %j',
  async (body) => {
    const { req, res } = call('POST', body);
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each([
  'not-json',
  JSON.stringify({
    choices: [{ finish_reason: 'length', message: { content: '{}' } }],
  }),
  JSON.stringify({
    choices: [
      {
        finish_reason: 'stop',
        message: { content: '{"type":"shell"}', tool_calls: [{}] },
      },
    ],
  }),
  'x'.repeat(65537),
])(
  'does not save malformed, truncated or tool-calling model output',
  async (wire) => {
    vi.mocked(fetch).mockResolvedValue(new Response(wire));
    const { req, res } = call();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(saveAutomationPlan).not.toHaveBeenCalled();
  },
);
it('saves only on PUT and reports failed application', async () => {
  vi.mocked(saveAutomationPlan).mockResolvedValue(defaultConfig());
  const { req, res } = call('PUT', { type: 'remove_rule', id: 'one' });
  await handler(req, res);
  expect(saveAutomationPlan).toHaveBeenCalledWith('alice', req.body);
  expect(fetch).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(200);
  vi.mocked(saveAutomationPlan).mockRejectedValue(new Error('stale'));
  const retry = call('PUT', req.body);
  await handler(retry.req, retry.res);
  expect(retry.res.status).toHaveBeenCalledWith(400);
});
