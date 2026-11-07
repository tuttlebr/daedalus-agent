import Anthropic from '@anthropic-ai/sdk';
import {
  type APIRequestContext,
  expect,
  request as playwrightRequest,
  test,
} from '@playwright/test';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';

// The real frontend, stream worker and Redis, with the deterministic mock
// backend. Clients are the pinned official SDKs (see package.json) using the
// Next.js port directly; the HTTPS loopback proxy is for browsers.
const apiOrigin = `http://127.0.0.1:${process.env.E2E_NEXT_PORT || '15002'}`;
const backendOrigin = `http://127.0.0.1:${
  process.env.E2E_MOCK_BACKEND_PORT || '18000'
}`;
const redisUrl =
  process.env.E2E_REDIS_URL ||
  'redis://default:e2e-redis-password@127.0.0.1:16379';

interface LedgerEntry {
  prompt: string;
  userId: string;
  conversationId: string | null;
  executionScope: string | null;
  responseMode: string | null;
  roles: string[];
  tags: string[];
  closed: boolean;
}

let session: APIRequestContext;
let apiKey: string;

async function ledger(marker: string): Promise<LedgerEntry[]> {
  const response = await fetch(
    `${backendOrigin}/__e2e/chat-requests?marker=${encodeURIComponent(marker)}`,
  );
  return (await response.json()) as LedgerEntry[];
}

async function createKey(name: string): Promise<{ key: string; id: string }> {
  const created = await session.post('/api/api-keys', { data: { name } });
  expect(created.status()).toBe(201);
  const body = await created.json();
  return { key: body.key, id: body.metadata.id };
}

function openai(
  options: Partial<ConstructorParameters<typeof OpenAI>[0]> = {},
) {
  return new OpenAI({ apiKey, baseURL: `${apiOrigin}/v1`, ...options });
}

function anthropic(
  options: Partial<ConstructorParameters<typeof Anthropic>[0]> = {},
) {
  return new Anthropic({ apiKey, baseURL: apiOrigin, ...options });
}

test.describe('OpenAI and Anthropic compatible API', () => {
  test.beforeAll(async () => {
    session = await playwrightRequest.newContext({
      baseURL: `https://127.0.0.1:${process.env.E2E_WEB_PORT || '15000'}`,
      ignoreHTTPSErrors: true,
    });
    const login = await session.post('/api/auth/login', {
      data: { username: 'e2e-user', password: 'e2e-password' },
    });
    expect(login.status()).toBe(200);
    apiKey = (await createKey(`e2e-${randomUUID()}`)).key;
  });

  test.afterAll(async () => {
    const listed = await (await session.get('/api/api-keys')).json();
    for (const key of listed.keys) {
      await session.delete(`/api/api-keys/${key.id}`);
    }
    await session.dispose();
  });

  test('official SDKs complete streamed and non-streamed text requests', async () => {
    const marker = `E2E_COMPAT_ANSWER ${randomUUID()}`;
    const completion = await openai().chat.completions.create({
      model: 'daedalus',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: `${marker} openai` },
      ],
    });
    expect(completion.choices[0].message.content).toBe(
      `Compat answer: café ✓ 👋 [artifact](${apiOrigin}/api/generated-image/e2e-image)`,
    );
    expect(completion.choices[0].finish_reason).toBe('stop');
    expect(completion.usage).toMatchObject({
      prompt_tokens: 321,
      completion_tokens: 45,
      total_tokens: 366,
      prompt_tokens_details: { cached_tokens: 21 },
    });

    const stream = await openai().chat.completions.create({
      model: 'daedalus',
      messages: [{ role: 'user', content: `${marker} openai stream` }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let streamed = '';
    let streamedUsage: unknown = null;
    for await (const chunk of stream) {
      streamed += chunk.choices[0]?.delta?.content ?? '';
      if (chunk.usage) streamedUsage = chunk.usage;
    }
    expect(streamed).toContain('café ✓ 👋');
    expect(streamedUsage).toMatchObject({ total_tokens: 366 });

    const message = await anthropic().messages.create({
      model: 'daedalus',
      max_tokens: 1024,
      system: 'Be terse.',
      messages: [{ role: 'user', content: `${marker} anthropic` }],
    });
    expect(message.content).toEqual([
      expect.objectContaining({ type: 'text' }),
    ]);
    expect((message.content[0] as { text: string }).text).toContain(
      'café ✓ 👋',
    );
    expect(message.stop_reason).toBe('end_turn');
    expect(message.usage).toMatchObject({
      input_tokens: 300,
      output_tokens: 45,
      cache_read_input_tokens: 21,
    });

    const final = await anthropic()
      .messages.stream({
        model: 'daedalus',
        max_tokens: 1024,
        messages: [{ role: 'user', content: `${marker} anthropic stream` }],
      })
      .finalMessage();
    expect((final.content[0] as { text: string }).text).toContain('👋');
    expect(final.usage).toMatchObject({ input_tokens: 300, output_tokens: 45 });

    const response = await openai()
      .responses.create({
        model: 'daedalus',
        input: `${marker} responses`,
        instructions: 'Be terse.',
        store: true,
      })
      .withResponse();
    expect(response.data.output_text).toContain('café ✓ 👋');
    expect(response.data.status).toBe('completed');
    expect(response.data.usage).toMatchObject({
      input_tokens: 321,
      output_tokens: 45,
      total_tokens: 366,
    });
    expect(
      response.response.headers.get('x-daedalus-ignored-parameters'),
    ).toContain('store');
    const responseFinal = await openai()
      .responses.stream({
        model: 'daedalus',
        input: `${marker} responses stream`,
      })
      .finalResponse();
    expect(responseFinal.output_text).toContain('café ✓ 👋');
    expect(responseFinal.status).toBe('completed');

    const openaiModels = await openai().models.list();
    expect(openaiModels.data.map((model) => model.id)).toEqual(['daedalus']);
    const anthropicModels = await anthropic().models.list();
    expect(anthropicModels.data.map((model) => model.id)).toEqual(['daedalus']);

    // The backend saw the key owner, final-only presentation, and caller
    // instructions placed after Daedalus identity, in isolated run scopes.
    const seen = await ledger(marker);
    expect(seen).toHaveLength(6);
    for (const entry of seen) {
      expect(entry.userId).toBe('e2e-user');
      expect(entry.responseMode).toBe('final_only');
      expect(entry.executionScope).toBeNull();
      expect(entry.conversationId).toMatch(/^api-/);
      expect(entry.roles.every((role) => role === 'user')).toBe(true);
      expect(entry.tags[0]).toBe('[IDENTITY]');
    }
    expect(
      seen.filter((entry) => entry.tags.includes('[CALLER_INSTRUCTIONS]')),
    ).toHaveLength(3);
  });

  test('quiet periods, truncation, and failures after partial output', async () => {
    const quiet = `E2E_SILENT_PREPARATION ${randomUUID()}`;
    let text = '';
    for await (const chunk of await openai().chat.completions.create({
      model: 'daedalus',
      messages: [{ role: 'user', content: quiet }],
      stream: true,
    })) {
      text += chunk.choices[0]?.delta?.content ?? '';
    }
    expect(text).toBe('E2E silent preparation complete');

    const truncated = await anthropic().messages.create({
      model: 'daedalus',
      max_tokens: 2,
      messages: [
        { role: 'user', content: `E2E_COMPAT_ANSWER ${randomUUID()}` },
      ],
    });
    expect(truncated.stop_reason).toBe('max_tokens');
    expect((truncated.content[0] as { text: string }).text).toBe('Compat a');

    // A failed run is an error, never a completion, and the SDK's automatic
    // retries do not run it again.
    const failure = `E2E_LATE_ERROR ${randomUUID()}`;
    const error = await openai()
      .chat.completions.create({
        model: 'daedalus',
        messages: [{ role: 'user', content: failure }],
      })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(OpenAI.APIError);
    expect(error.status).toBe(502);
    expect(error.message).toContain('run');
    expect(await ledger(failure)).toHaveLength(1);

    const streamedFailure = `E2E_LATE_ERROR ${randomUUID()}`;
    const streamError = await (async () => {
      const stream = anthropic().messages.stream({
        model: 'daedalus',
        max_tokens: 64,
        messages: [{ role: 'user', content: streamedFailure }],
      });
      return stream.finalMessage().catch((caught) => caught);
    })();
    expect(streamError).toBeInstanceOf(Error);
    expect(await ledger(streamedFailure)).toHaveLength(1);
  });

  test('vendor features are accepted, reported and dropped before execution', async () => {
    const marker = `E2E_COMPAT_ANSWER ${randomUUID()}`;
    const chat = await openai()
      .chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: marker },
              {
                type: 'image_url',
                image_url: { url: 'https://external.invalid/image.png' },
              },
            ],
          },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'external_tool', parameters: { type: 'object' } },
          },
        ],
        response_format: { type: 'json_object' },
        store: true,
      })
      .withResponse();
    expect(chat.data.choices[0].message.content).toContain('Compat answer');
    expect(
      chat.response.headers.get('x-daedalus-ignored-parameters'),
    ).toContain('tools');
    const message = await anthropic({
      defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
    })
      .messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 256,
        messages: [{ role: 'user', content: marker }],
        tools: [{ name: 'external_tool', input_schema: { type: 'object' } }],
      })
      .withResponse();
    expect(
      message.response.headers.get('x-daedalus-ignored-parameters'),
    ).toContain('anthropic-beta');
    const response = await openai()
      .responses.create({
        model: 'gpt-4o',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: marker },
              { type: 'input_file', file_id: 'file_external' },
            ],
          },
        ],
        previous_response_id: 'resp_external',
        tools: [{ type: 'file_search', vector_store_ids: ['vs_external'] }],
        background: true,
      })
      .withResponse();
    expect(response.data.output_text).toContain('Compat answer');
    expect(
      response.response.headers.get('x-daedalus-ignored-parameters'),
    ).toContain('previous_response_id');
    const seen = await ledger(marker);
    expect(seen).toHaveLength(3);
    for (const entry of seen) {
      expect(entry.prompt).not.toContain('external.invalid');
      expect(entry.prompt).not.toContain('file_external');
      expect(entry.prompt).not.toContain('external_tool');
      expect(entry.userId).toBe('e2e-user');
      expect(entry.responseMode).toBe('final_only');
    }
  });

  test('Responses handles idempotency, truncation and streaming failures', async () => {
    const marker = `E2E_COMPAT_ANSWER ${randomUUID()}`;
    const options = { headers: { 'Idempotency-Key': randomUUID() } };
    const body = { model: 'daedalus', input: marker, max_output_tokens: 2 };
    const first = await openai().responses.create(body, options);
    const second = await openai().responses.create(body, options);
    expect(second.id).toBe(first.id);
    expect(second.output_text).toBe('Compat a');
    expect(second.status).toBe('incomplete');
    expect(second.incomplete_details?.reason).toBe('max_output_tokens');
    expect(await ledger(marker)).toHaveLength(1);
    const failure = `E2E_LATE_ERROR ${randomUUID()}`;
    await expect(
      openai()
        .responses.stream({ model: 'daedalus', input: failure })
        .finalResponse(),
    ).rejects.toThrow();
    expect(await ledger(failure)).toHaveLength(1);
  });

  test('keys, identity headers, and conversation ownership are enforced', async () => {
    const marker = `E2E_COMPAT_ANSWER ${randomUUID()}`;
    // Forged trusted headers are ignored; the run belongs to the key owner.
    await openai({
      defaultHeaders: {
        'x-user-id': 'mallory',
        'x-daedalus-internal-token': 'forged',
        'x-daedalus-execution-scope': 'autonomy',
      },
    }).chat.completions.create({
      model: 'daedalus',
      messages: [{ role: 'user', content: marker }],
    });
    const [entry] = await ledger(marker);
    expect(entry.userId).toBe('e2e-user');
    expect(entry.executionScope).toBeNull();

    const revoked = await createKey('revoked');
    expect((await session.delete(`/api/api-keys/${revoked.id}`)).status()).toBe(
      200,
    );
    for (const key of [
      revoked.key,
      'dkey_0000000000000000_' + 'A'.repeat(43),
    ]) {
      const status = await openai({ apiKey: key, maxRetries: 0 })
        .chat.completions.create({
          model: 'daedalus',
          messages: [{ role: 'user', content: marker }],
        })
        .then(
          () => 200,
          (error) => error.status,
        );
      expect(status).toBe(401);
    }
    const anonymous = await fetch(`${apiOrigin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'daedalus',
        messages: [{ role: 'user', content: marker }],
      }),
    });
    expect(anonymous.status).toBe(401);

    // Another account's conversation is indistinguishable from a missing one.
    const foreign = `foreign-${randomUUID()}`;
    const redis = new Redis(redisUrl);
    try {
      await redis.set(
        `conversation:${foreign}`,
        JSON.stringify({ id: foreign, ownerId: 'someone-else', messages: [] }),
      );
      await redis.sadd('user:someone-else:conversations', foreign);
      const status = await openai({
        defaultHeaders: { 'X-Daedalus-Conversation-ID': foreign },
      })
        .chat.completions.create({
          model: 'daedalus',
          messages: [{ role: 'user', content: `${marker} foreign` }],
        })
        .then(
          () => 200,
          (error) => error.status,
        );
      expect(status).toBe(404);
      expect(await ledger(`${marker} foreign`)).toHaveLength(0);
    } finally {
      await redis.del(`conversation:${foreign}`);
      await redis.srem('user:someone-else:conversations', foreign);
      await redis.quit();
    }
    expect(await ledger(marker)).toHaveLength(1);
  });

  test('approvals and OAuth are surfaced without executing protected actions', async () => {
    const approval = `E2E_APPROVAL_REQUEST ${randomUUID()}`;
    const error = await openai()
      .chat.completions.create({
        model: 'daedalus',
        messages: [{ role: 'user', content: approval }],
      })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(OpenAI.PermissionDeniedError);
    const details = error.error.daedalus;
    expect(error.error.code).toBe('approval_required');
    expect(details.requirement).toBe('mcp_approval');
    expect(details.conversation_id).toBe(`api-${details.run_id}`);
    expect(details.action_url).toBe(
      `${apiOrigin}/?conversation=${details.conversation_id}`,
    );
    // The approval prompt is saved where the signed-in user can answer it.
    const saved = await session.get(
      `/api/conversations/${details.conversation_id}`,
    );
    expect(saved.status()).toBe(200);
    const conversation = await saved.json();
    expect(JSON.stringify(conversation)).toContain('daedalus-mcp-approval');

    // The conversation can be continued through the API.
    const next = `E2E_COMPAT_ANSWER ${randomUUID()}`;
    const continued = await openai({
      defaultHeaders: {
        'X-Daedalus-Conversation-ID': details.conversation_id,
      },
    })
      .chat.completions.create({
        model: 'daedalus',
        messages: [{ role: 'user', content: next }],
      })
      .withResponse();
    expect(continued.response.headers.get('x-daedalus-conversation-id')).toBe(
      details.conversation_id,
    );
    expect((await ledger(next))[0].conversationId).toBe(
      details.conversation_id,
    );

    const oauth = `E2E_OAUTH_SIBLING ${randomUUID()}`;
    const oauthError = await anthropic()
      .messages.create({
        model: 'daedalus',
        max_tokens: 64,
        messages: [{ role: 'user', content: oauth }],
      })
      .catch((caught) => caught);
    expect(oauthError).toBeInstanceOf(Anthropic.PermissionDeniedError);
    expect(oauthError.error.error.daedalus).toMatchObject({
      requirement: 'oauth',
      action_url: `${apiOrigin}/?view=connections`,
    });
    // The run waiting for the browser callback was stopped.
    await expect
      .poll(async () => (await ledger(oauth))[0]?.closed, { timeout: 15_000 })
      .toBe(true);
  });

  test('idempotent retries never start a second run', async () => {
    const marker = `E2E_SILENT_PREPARATION ${randomUUID()}`;
    const key = randomUUID();
    const send = (content = marker) =>
      openai().chat.completions.create(
        { model: 'daedalus', messages: [{ role: 'user', content }] },
        { headers: { 'Idempotency-Key': key } },
      );
    // Concurrent duplicates attach to one run.
    const [first, second] = await Promise.all([send(), send()]);
    expect(first.choices[0].message.content).toBe(
      'E2E silent preparation complete',
    );
    expect(second.choices[0].message.content).toBe(
      first.choices[0].message.content,
    );
    // A later duplicate replays the retained answer.
    const replay = await send().withResponse();
    expect(replay.response.headers.get('x-daedalus-idempotent-replay')).toBe(
      'true',
    );
    expect(replay.data.id).toBe(first.id);
    expect(await ledger(marker)).toHaveLength(1);

    const conflict = await send(`${marker} changed`).catch((caught) => caught);
    expect(conflict.status).toBe(409);
    expect(await ledger(`${marker} changed`)).toHaveLength(0);
  });

  test('disconnects, conversation locks, and shared limits release capacity', async () => {
    const marker = `E2E_CANCEL ${randomUUID()}`;
    const controller = new AbortController();
    const pending = fetch(`${apiOrigin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'daedalus',
        stream: true,
        messages: [{ role: 'user', content: marker }],
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        await response.body?.getReader().read();
      })
      .catch(() => undefined);
    await expect
      .poll(async () => (await ledger(marker)).length, { timeout: 15_000 })
      .toBe(1);
    controller.abort();
    await pending;
    await expect
      .poll(async () => (await ledger(marker))[0].closed, { timeout: 15_000 })
      .toBe(true);

    const raw = (content: string, headers: Record<string, string> = {}) =>
      fetch(`${apiOrigin}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          model: 'daedalus',
          messages: [{ role: 'user', content }],
        }),
      });

    // One active response per conversation, as in the web app.
    const conversation = `compat-${randomUUID()}`;
    const slowMarker = `E2E_SILENT_PREPARATION ${randomUUID()}`;
    const slow = raw(slowMarker, {
      'x-daedalus-conversation-id': conversation,
    });
    // The backend has the request, so the conversation is held.
    await expect
      .poll(async () => (await ledger(slowMarker)).length, { timeout: 15_000 })
      .toBe(1);
    const busy = await raw(`E2E_COMPAT_ANSWER ${randomUUID()}`, {
      'x-daedalus-conversation-id': conversation,
    });
    expect(busy.status).toBe(409);
    expect(busy.headers.get('x-should-retry')).toBe('true');
    expect((await slow).status).toBe(200);

    // The cancelled run's slot was released: five runs fit, a sixth waits.
    const runs = Array.from({ length: 5 }, () =>
      raw(`E2E_SILENT_PREPARATION ${randomUUID()}`),
    );
    await expect
      .poll(
        async () =>
          (
            await ledger('E2E_SILENT_PREPARATION')
          ).filter((entry) => !entry.closed).length,
        { timeout: 15_000 },
      )
      .toBe(5);
    const sixth = await raw(`E2E_COMPAT_ANSWER ${randomUUID()}`);
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('x-should-retry')).toBe('true');
    expect(
      (await Promise.all(runs)).map((response) => response.status),
    ).toEqual([200, 200, 200, 200, 200]);
  });
});
