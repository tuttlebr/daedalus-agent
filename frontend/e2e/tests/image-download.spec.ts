import { assertAuthenticatedSession } from '../helpers/auth';
import { navigate } from '../helpers/design';

import { expect, test } from '@playwright/test';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test.use({ serviceWorkers: 'block' });

test('Create saves original images while keeping its page and selection', async ({
  page,
  context,
}) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('e2e-user');
  await page.getByLabel('Password').fill('e2e-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/');
  await assertAuthenticatedSession(page);
  const imageId = randomUUID();
  const filename = `daedalus-${imageId}.png`;
  const original = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=',
    'base64',
  );
  const redis = new Redis(
    process.env.E2E_REDIS_URL ||
      'redis://default:e2e-redis-password@127.0.0.1:16379',
  );
  const key = `generated:image:${imageId}`;
  try {
    await redis.set(
      key,
      JSON.stringify({
        data: original.toString('base64'),
        mimeType: 'image/png',
        userId: 'e2e-user',
      }),
      'EX',
      120,
    );
    const isIOS = await page.evaluate(
      () =>
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    );
    if (isIOS) {
      // Linux WebKit cannot present the native iOS sheet. Verify the real file
      // and user activation at that boundary, including cancellation/retry.
      await page.evaluate(() => {
        const calls: unknown[] = [];
        Object.assign(window, { imageSaveCalls: calls });
        Object.defineProperty(navigator, 'canShare', {
          configurable: true,
          value: ({ files }: ShareData) => files?.[0] instanceof File,
        });
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: async ({ files }: ShareData) => {
            const file = files![0];
            const active = navigator.userActivation.isActive;
            const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
            calls.push({ name: file.name, type: file.type, active, bytes });
            if (calls.length === 1)
              throw new DOMException('Cancelled', 'AbortError');
          },
        });
      });
    }
    await page.route('**/api/images/history*', (route) =>
      route.fulfill({
        json: {
          history: [
            {
              id: 'download-fixture',
              mode: 'generate',
              prompt: 'Original image',
              model: 'gpt-image-2.5-sunburst',
              params: { output_format: 'png' },
              inputImages: [],
              maskImage: null,
              outputImageIds: [imageId],
              createdAt: 1,
            },
          ],
        },
      }),
    );
    let downloadNavigations = 0;
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (
        url.pathname === `/api/generated-image/${imageId}` &&
        url.searchParams.has('download') &&
        request.isNavigationRequest()
      ) {
        downloadNavigations++;
      }
    });
    await navigate(page, 'Create');
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page
      .getByRole('button', { name: 'Restore saved generate creation' })
      .click();
    const tile = page.getByRole('button', {
      name: 'Open generated image actions',
    });
    await tile.click();
    const initialUrl = page.url();
    const pageCount = context.pages().length;

    if (isIOS) {
      const save = page.getByRole('button', { name: 'Download', exact: true });
      await expect(save).toBeEnabled();
      await save.click();
      await expect(save).toBeEnabled();
      await expect(
        page
          .getByRole('dialog', { name: 'Selected image actions' })
          .getByRole('alert'),
      ).toHaveCount(0);
      await save.click();
      await expect(save).toBeEnabled();
      const calls = await page.evaluate(
        () =>
          (window as unknown as { imageSaveCalls: unknown[] }).imageSaveCalls,
      );
      expect(calls).toEqual(
        Array(2).fill({
          name: filename,
          type: 'image/png',
          active: true,
          bytes: Array.from(original),
        }),
      );
      expect(downloadNavigations).toBe(0);
    } else {
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Download', exact: true }).click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toBe(filename);
      expect(await readFile((await download.path())!)).toEqual(original);
    }
    expect(page.url()).toBe(initialUrl);
    expect(context.pages()).toHaveLength(pageCount);
    if ((page.viewportSize()?.width || 0) < 1024) {
      await page
        .getByRole('button', { name: 'Close selected image actions' })
        .click();
    }
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
    await expect(tile).toBeVisible();
  } finally {
    await redis.del(key);
    await redis.quit();
  }
});
