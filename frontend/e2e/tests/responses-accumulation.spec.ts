import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';

const fixtures = JSON.parse(
  readFileSync(
    path.resolve(
      '../builder/runtime/tests/fixtures/responses-accumulation.json',
    ),
    'utf8',
  ),
) as Array<{ name: string; expected: string; error: boolean }>;

for (const fixture of fixtures.filter((fixture) => !fixture.error)) {
  test(`Responses ${fixture.name} reaches the browser and survives reload`, async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill('e2e-user');
    await page.getByLabel('Password').fill('e2e-password');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page).toHaveURL('/');
    await page
      .getByPlaceholder('Send a message...')
      .fill(`RESPONSES_CASE:${fixture.name}`);
    const submitted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/chat/async'),
    );
    await page.getByRole('button', { name: 'Send message' }).click();
    const { jobId } = await (await submitted).json();
    if (fixture.name === 'correction' || fixture.name === 'empty_correction') {
      const provisional =
        fixture.name === 'correction'
          ? 'Provisional text that is too long'
          : 'Remove this';
      await expect(page.getByText(provisional, { exact: true })).toBeVisible();
      await expect(page.getByText(provisional, { exact: true })).toBeHidden();
      if (fixture.name === 'correction') {
        await expect(
          page.getByText('Corrected', { exact: true }),
        ).toBeVisible();
      }
      await expect(
        page.getByRole('button', { name: 'Stop generating' }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole('button', { name: 'Stop generating' }),
    ).toBeHidden();
    const status = await (
      await page.request.get(`/api/chat/async?jobId=${jobId}`)
    ).json();
    expect(status.status).toBe('completed');
    expect(status.fullResponse).toBe(fixture.expected);
    for (const paragraph of fixture.expected.split('\n\n')) {
      await expect(
        page.getByText(paragraph, { exact: true }).last(),
      ).toBeVisible();
    }
    await page.reload();
    for (const paragraph of fixture.expected.split('\n\n')) {
      await expect(
        page.getByText(paragraph, { exact: true }).last(),
      ).toBeVisible();
    }
  });
}

test('official Responses SDK accumulates the public endpoint and reports upstream failures', async ({
  request,
}) => {
  expect(
    (
      await request.post('/api/auth/login', {
        data: { username: 'e2e-user', password: 'e2e-password' },
      })
    ).ok(),
  ).toBeTruthy();
  const created = await request.post('/api/api-keys', {
    data: { name: 'Responses accumulation fixture' },
  });
  expect(created.status()).toBe(201);
  const { key, metadata } = await created.json();
  try {
    const client = new OpenAI({
      apiKey: key,
      baseURL: `http://127.0.0.1:${process.env.E2E_NEXT_PORT || '15002'}/v1`,
      maxRetries: 0,
    });
    for (const name of [
      'multiple_parts',
      'correction',
      'refusal',
      'terminal_only',
    ]) {
      const response = await client.responses
        .stream({ model: 'daedalus', input: `RESPONSES_CASE:${name}` })
        .finalResponse();
      expect(response.status).toBe('completed');
      expect(response.output_text).toBe(
        fixtures.find((fixture) => fixture.name === name)!.expected,
      );
      expect(response.usage).toMatchObject({
        input_tokens: 7,
        output_tokens: 3,
      });
    }
    const unary = await client.responses.create({
      model: 'daedalus',
      input: 'RESPONSES_CASE:snapshots',
    });
    expect(unary.output_text).toBe(
      fixtures.find((fixture) => fixture.name === 'snapshots')!.expected,
    );
    for (const name of ['failed', 'truncated', 'incomplete']) {
      await expect(
        client.responses
          .stream({ model: 'daedalus', input: `RESPONSES_CASE:${name}` })
          .finalResponse(),
      ).rejects.toThrow();
    }
  } finally {
    await request.delete(`/api/api-keys/${metadata.id}`);
  }
});
