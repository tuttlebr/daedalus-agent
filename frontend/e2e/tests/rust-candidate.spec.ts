import { assertAuthenticatedSession } from '../helpers/auth';

import { expect, test } from '@playwright/test';

test('candidate image streams a native tool result through the real worker and supports Stop', async ({
  page,
}) => {
  expect(process.env.E2E_CANDIDATE_IMAGE).toBeTruthy();
  await page.goto('/login');
  await page.getByLabel('Username').fill('e2e-user');
  await page.getByLabel('Password').fill('e2e-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/');
  await assertAuthenticatedSession(page);
  const input = page.getByPlaceholder('Send a message...');
  await input.fill('BASIC synthetic candidate clock request');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(
    page
      .getByText('The real datetime tool completed', { exact: false })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Stop generating' }),
  ).toBeHidden();
  await page.reload();
  await expect(
    page
      .getByText('The real datetime tool completed', { exact: false })
      .first(),
  ).toBeVisible();
  await input.fill('MODEL_STEER synthetic candidate cancellation request');
  await page.getByRole('button', { name: 'Send message' }).click();
  const stop = page.getByRole('button', { name: 'Stop generating' });
  await expect(stop).toBeVisible();
  const cancellation = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().includes('/api/chat/async'),
  );
  await stop.click();
  expect((await cancellation).ok()).toBeTruthy();
  await expect(stop).toBeHidden();
  await expect(input).toBeEnabled();
  await input.fill('MODEL_STEER synthetic candidate steering request');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(stop).toBeVisible();
  await page
    .getByPlaceholder('Add a direction while Daedalus works...')
    .fill('NEW_DIRECTION: answer now');
  await page.getByRole('button', { name: 'Steer response' }).click();
  await expect(
    page.getByText('Directed answer', { exact: false }).first(),
  ).toBeVisible();
  await expect(stop).toBeHidden();
});
