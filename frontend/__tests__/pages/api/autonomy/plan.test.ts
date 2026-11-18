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
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('identifies a backend connection failure without leaking its exception', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(fetch).mockRejectedValue(new Error('private backend URL'));
  const { req, res } = call();
  await handler(req, res);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'planning_unreachable' }),
  );
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
    'private backend',
  );
  const requestId = res.setHeader.mock.calls.find(
    ([name]: [string]) => name === 'X-Request-Id',
  )[1];
  expect(console.warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ requestId }),
  );
});

it('reports the preview deadline as a timeout and cancels the backend request', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.useFakeTimers();
  vi.mocked(fetch).mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  );
  const { req, res } = call();
  const pending = handler(req, res);
  await vi.advanceTimersByTimeAsync(120000);
  await pending;
  expect(res.status).toHaveBeenCalledWith(504);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'planning_timeout' }),
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
});

it('identifies unavailable capabilities on save without treating that as a policy block', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(fetch).mockRejectedValue(new Error('private service URL'));
  const { req, res } = call('PUT', {
    type: 'automation',
    rule: { allowedTools: ['weather'] },
  });
  await handler(req, res);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'capabilities_unavailable' }),
  );
  expect(saveAutomationPlan).not.toHaveBeenCalled();
});

it('attributes a failed capabilities lookup to connected services and logs its status', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(fetch).mockResolvedValue(
    new Response('private diagnostics', { status: 500 }),
  );
  const { req, res } = call('PUT', {
    type: 'automation',
    rule: { allowedTools: ['weather'] },
  });
  await handler(req, res);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'capabilities_unavailable' }),
  );
  expect(console.warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ upstreamStatus: 500 }),
  );
  expect(saveAutomationPlan).not.toHaveBeenCalled();
});

function modelResponse(content: unknown, finishReason = 'stop') {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: finishReason,
          message: { content: JSON.stringify(content) },
        },
      ],
    }),
  );
}

it.each([
  [401, 502, 'service_authentication'],
  [403, 502, 'service_authentication'],
  [404, 503, 'planning_unavailable'],
  [429, 429, 'planning_busy'],
  [500, 502, 'model_failed'],
  [503, 503, 'capabilities_unavailable'],
  [504, 504, 'planning_timeout'],
])(
  'explains backend HTTP %i without exposing its body',
  async (status, expected, code) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValue(
      new Response('private upstream credentials', { status }),
    );
    const { req, res } = call();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(expected);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code, error: expect.any(String) }),
    );
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(
      'private upstream',
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code, upstreamStatus: status }),
    );
  },
);

it('distinguishes invalid model output from an intentional unsupported decision', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(fetch).mockResolvedValue(modelResponse({ type: 'shell' }));
  const invalid = call();
  await handler(invalid.req, invalid.res);
  expect(invalid.res.json).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'invalid_plan' }),
  );
  const blocked = {
    type: 'unsupported',
    message:
      'Pod deletion requires interactive approval. Review the Kubernetes service permissions, then preview again.',
  };
  vi.mocked(fetch).mockResolvedValue(modelResponse(blocked));
  const unsupported = call('POST', {
    instructions:
      'Clean up pods across all Kubernetes namespaces where their status is "Completed"',
  });
  await handler(unsupported.req, unsupported.res);
  expect(unsupported.res.status).toHaveBeenCalledWith(200);
  expect(unsupported.res.json).toHaveBeenCalledWith(blocked);
  expect(saveAutomationPlan).not.toHaveBeenCalled();
});

it('explains an unavailable operation when preview validation blocks a plan', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      modelResponse({
        type: 'automation',
        settings: {
          title: 'Completed pod cleanup',
          instructions: 'Remove completed pods across all namespaces.',
          allowedTools: ['k8s_mcp_server__deleteResource'],
          intervalSeconds: 3600,
          dailyTimes: [],
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        },
      }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ tools: [] })));
  const { req, res } = call();
  await handler(req, res);
  expect(res.status).toHaveBeenCalledWith(422);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({
      code: 'operation_unavailable',
      error: expect.stringContaining('blocked'),
    }),
  );
  expect(saveAutomationPlan).not.toHaveBeenCalled();
});

it.each(['content_filter', 'refusal'])(
  'reports a model %s as a block',
  async (reason) => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: reason === 'content_filter' ? reason : 'stop',
              message: {
                content: null,
                refusal:
                  reason === 'refusal'
                    ? 'This request cannot be prepared.'
                    : undefined,
              },
            },
          ],
        }),
      ),
    );
    const { req, res } = call();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'unsupported',
        message: expect.stringContaining('model'),
      }),
    );
  },
);

it('identifies a truncated response and settings storage failure separately', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(fetch).mockResolvedValue(modelResponse({}, 'length'));
  const truncated = call();
  await handler(truncated.req, truncated.res);
  expect(truncated.res.json).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'incomplete_response' }),
  );
  vi.mocked(getConfig).mockRejectedValue(new Error('private Redis address'));
  const storage = call();
  await handler(storage.req, storage.res);
  expect(storage.res.status).toHaveBeenCalledWith(503);
  expect(storage.res.json).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'settings_unavailable' }),
  );
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
    'private Redis',
  );
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

it('checks current service tools when saving a custom automation', async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ tools: ['nws_weather_tool'] })),
  );
  vi.mocked(saveAutomationPlan).mockResolvedValue(defaultConfig());
  const plan = {
    type: 'automation',
    rule: { allowedTools: ['nws_weather_tool'] },
  };
  const request = call('PUT', plan);
  await handler(request.req, request.res);
  expect(request.res.status).toHaveBeenCalledWith(200);
  expect(saveAutomationPlan).toHaveBeenCalledWith('alice', plan);
  expect(fetch).toHaveBeenCalledWith(
    'http://backend:8000/internal/autonomy/capabilities',
    expect.objectContaining({
      headers: expect.objectContaining({ 'x-user-id': 'alice' }),
    }),
  );
  vi.mocked(saveAutomationPlan).mockClear();
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ tools: [] })),
  );
  const revoked = call('PUT', plan);
  await handler(revoked.req, revoked.res);
  expect(revoked.res.status).toHaveBeenCalledWith(422);
  expect(revoked.res.json).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'operation_unavailable' }),
  );
  expect(saveAutomationPlan).not.toHaveBeenCalled();
});

it('reads a fragmented streaming planning response and returns the validated draft', async () => {
  const content = JSON.stringify({ type: 'clarify', message: 'Which day? 雪' });
  const wire =
    'data: ' +
    JSON.stringify({
      choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
    }) +
    '\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(wire);
  vi.mocked(fetch).mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 3)
            controller.enqueue(bytes.slice(i, i + 3));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  );
  const { req, res } = call();
  await handler(req, res);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({
    type: 'clarify',
    message: 'Which day? 雪',
  });
});
