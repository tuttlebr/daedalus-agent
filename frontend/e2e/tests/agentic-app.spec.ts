import { expect, test, type Page, type Response } from '@playwright/test';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';

const controlUrl = 'http://127.0.0.1:15099';
const redisUrl =
  process.env.E2E_REDIS_URL ||
  'redis://default:e2e-redis-password@127.0.0.1:16379';

async function setWebsocketState(state: 'start' | 'stop') {
  const response = await fetch(`${controlUrl}/ws/${state}`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Unable to ${state} E2E WebSocket sidecar`);
  }
}

async function login(page: Page) {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  const username = page.getByLabel('Username');
  const password = page.getByLabel('Password');
  await username.fill('e2e-user');
  await password.fill('e2e-password');
  await expect(username).toHaveValue('e2e-user');
  await expect(password).toHaveValue('e2e-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByPlaceholder('Send a message...')).toBeVisible();
}

async function sendMessage(page: Page, message: string) {
  await page.getByPlaceholder('Send a message...').fill(message);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(
    page.getByRole('button', { name: 'Stop generating' }),
  ).toBeVisible();
}

function isJobStatusGet(response: Response) {
  return (
    response.request().method() === 'GET' &&
    response.url().includes('/api/chat/async?jobId=')
  );
}

async function browserGet(page: Page, url: string) {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { credentials: 'include' });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
    };
  }, url);
}

async function browserPost(page: Page, url: string, body: unknown) {
  return page.evaluate(
    async ({ target, payload }) => {
      const response = await fetch(target, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return {
        ok: response.ok,
        status: response.status,
        body: await response.text(),
      };
    },
    { target: url, payload: body },
  );
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async () => {
  await setWebsocketState('start');
});

test.afterEach(async () => {
  await setWebsocketState('start');
});

test('logs in through the real session boundary', async ({ page }) => {
  await login(page);

  const me = await browserGet(page, '/api/auth/me');
  expect(me.ok).toBeTruthy();
  expect(JSON.parse(me.body)).toMatchObject({
    authenticated: true,
    user: { username: 'e2e-user', name: 'E2E User' },
  });
});

test('streams a chat completion over the WebSocket path', async ({ page }) => {
  let websocketConnected = false;
  let chatTokenReceived = false;
  page.on('websocket', (socket) => {
    if (!socket.url().includes(':15001')) return;
    socket.on('framereceived', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString();
      if (text.includes('"type":"connected"')) websocketConnected = true;
      if (text.includes('"type":"chat_token"')) chatTokenReceived = true;
    });
  });

  await login(page);
  await expect.poll(() => websocketConnected).toBeTruthy();

  await sendMessage(page, 'E2E_STREAM');
  await expect(
    page.getByText('E2E streamed reply', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Stop generating' }),
  ).toBeHidden();

  expect(chatTokenReceived).toBeTruthy();
});

test('cancels active backend work through the durable job endpoint', async ({
  page,
}) => {
  await login(page);
  const jobCreated = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/chat/async'),
  );
  await sendMessage(page, 'E2E_CANCEL');
  const createdResponse = await jobCreated;
  expect(createdResponse.ok()).toBeTruthy();

  const cancelResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().includes('/api/chat/async?jobId='),
  );
  await page.getByRole('button', { name: 'Stop generating' }).click();
  const canceled = await cancelResponse;
  expect(canceled.ok()).toBeTruthy();
  expect(await canceled.json()).toMatchObject({
    success: true,
    canceled: true,
  });
  await expect(
    page.getByRole('button', { name: 'Stop generating' }),
  ).toBeHidden();
});

test('rejects a second active job for the same conversation', async ({
  page,
}) => {
  await login(page);
  const jobCreated = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/chat/async'),
  );
  await sendMessage(page, 'E2E_CANCEL');
  const createdResponse = await jobCreated;
  expect(createdResponse.ok()).toBeTruthy();

  const submitted = createdResponse.request().postDataJSON() as {
    conversationId?: string;
  };
  expect(submitted.conversationId).toBeTruthy();
  const duplicate = await browserPost(page, '/api/chat/async', {
    conversationId: submitted.conversationId,
    conversationName: 'Concurrent submission check',
    messages: [{ role: 'user', content: 'This turn must be rejected' }],
  });
  expect(duplicate.status).toBe(409);
  expect(JSON.parse(duplicate.body)).toMatchObject({
    reason: 'conversation_job_active',
  });

  const cancelResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().includes('/api/chat/async?jobId='),
  );
  await page.getByRole('button', { name: 'Stop generating' }).click();
  expect((await cancelResponse).ok()).toBeTruthy();
});

test('streams a multipart document to S3 storage and reads the stored bytes', async ({
  page,
}) => {
  await login(page);
  const contents = 'deterministic document bytes for the S3 browser test\n';
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/session/documentStorage'),
  );

  await page.locator('input[type="file"]').setInputFiles({
    name: 'e2e-document.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(contents),
  });

  const uploaded = await uploadResponse;
  expect(uploaded.ok()).toBeTruthy();
  const reference = (await uploaded.json()) as {
    documentId: string;
    sessionId: string;
    userId: string;
  };
  expect(reference.userId).toBe('e2e-user');
  await expect(
    page.getByText('e2e-document.txt', { exact: true }).last(),
  ).toBeVisible();
  await expect(
    page.locator('select option[value="e2e_user_private"]'),
  ).toHaveText('E2E private knowledge base');

  const stored = await browserGet(
    page,
    `/api/session/documentStorage?documentId=${encodeURIComponent(
      reference.documentId,
    )}&sessionId=${encodeURIComponent(reference.sessionId)}`,
  );
  expect(stored.ok).toBeTruthy();
  expect(stored.body).toBe(contents);
});

test('approves one exact MCP action through interactive chat', async ({
  page,
}) => {
  await login(page);
  const redis = new Redis(redisUrl);
  const requestId = 'e2e_approval_request_123';
  const canonicalArguments = '{"document_id":"doc-e2e","text":"hello"}';
  const safeUser = createHash('sha256')
    .update('e2e-user')
    .digest('hex')
    .slice(0, 16);
  const pendingKey = `approval-pending:${safeUser}:${requestId}`;
  const approval = {
    request_id: requestId,
    user_id: 'e2e-user',
    action_type: 'mcp_mutation',
    action: 'Update the selected Google document',
    reason: 'This document mutation needs an explicit human decision.',
    target: 'document/doc-e2e',
    server_name: 'docs_mcp_server',
    tool_name: 'update_doc',
    canonical_arguments: canonicalArguments,
    arguments_preview: canonicalArguments,
    arguments_sha256: createHash('sha256')
      .update(canonicalArguments)
      .digest('hex'),
    created_at: Math.floor(Date.now() / 1000),
  };
  await redis.setex(pendingKey, 300, JSON.stringify(approval));

  await sendMessage(page, 'E2E_APPROVAL_REQUEST');
  await expect(
    page.getByText('e2e_approval_request_123', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Stop generating' }),
  ).toBeHidden();

  await sendMessage(page, 'yes');
  await expect(
    page.getByText('E2E approved credential received', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Stop generating' }),
  ).toBeHidden();

  expect(await redis.exists(pendingKey)).toBe(0);
  const tokenKeys = await redis.keys(`approval:${safeUser}:*`);
  expect(tokenKeys).toHaveLength(1);
  await redis.del(...tokenKeys);
  await redis.quit();
});

test('falls back to polling when WebSocket is unavailable', async ({
  page,
}) => {
  await setWebsocketState('stop');
  await login(page);

  const polled = page.waitForResponse(isJobStatusGet);
  await sendMessage(page, 'E2E_UNAVAILABLE');
  expect((await polled).ok()).toBeTruthy();
  await expect(
    page.getByText('E2E polling fallback reply', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Stop generating' }),
  ).toBeHidden();
});

test('recovers a completion by polling after a live WebSocket disconnect', async ({
  page,
}) => {
  await login(page);
  await sendMessage(page, 'E2E_DISCONNECT');
  await expect(
    page.getByText('E2E before disconnect', { exact: true }),
  ).toBeVisible();

  const polled = page.waitForResponse(isJobStatusGet);
  await setWebsocketState('stop');
  expect((await polled).ok()).toBeTruthy();
  await expect(
    page.getByText('E2E before disconnect recovered by polling', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Stop generating' }),
  ).toBeHidden();
});
