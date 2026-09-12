import { assertAuthenticatedSession } from '../helpers/auth';

import { expect, test } from '@playwright/test';
import Redis from 'ioredis';

test('uploaded and legacy SVG remain inert on direct authenticated navigation', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('e2e-user');
  await page.getByLabel('Password').fill('e2e-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/');
  await assertAuthenticatedSession(page);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><script>window.__svgExecuted=true</script><rect width="24" height="24" fill="red"/></svg>';
  // Exercise upload through the browser's authenticated HTTPS session.
  const uploaded = await page.evaluate(async (base64Data) => {
    const response = await fetch('/api/session/imageStorage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64Data, mimeType: 'image/svg+xml' }),
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  }, Buffer.from(svg).toString('base64'));
  expect(uploaded.status).toBe(200);
  const image = uploaded.body;
  const legacyId = `legacy-svg-${Date.now()}`;
  const redis = new Redis(
    process.env.E2E_REDIS_URL ||
      'redis://default:e2e-redis-password@127.0.0.1:16379',
  );
  const key = `user:e2e-user:image:${legacyId}`;
  try {
    await redis.set(
      key,
      JSON.stringify({
        id: legacyId,
        data: Buffer.from(svg).toString('base64'),
        mimeType: 'image/svg+xml',
        userId: 'e2e-user',
        sessionId: image.sessionId,
      }),
      'EX',
      120,
    );
    for (const id of [image.imageId, legacyId]) {
      const response = await page.goto(
        `/api/session/imageStorage?imageId=${id}`,
      );
      expect(response?.status()).toBe(200);
      expect(response?.headers()['content-type']).toMatch(/^image\/(png|jpeg)/);
      expect(response?.headers()['content-security-policy']).toContain(
        'sandbox',
      );
      expect(
        await page.evaluate(() => (window as any).__svgExecuted),
      ).toBeUndefined();
      expect(
        await page
          .locator('img')
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      ).toBeGreaterThan(0);
    }
  } finally {
    await redis.del(key);
    await redis.quit();
  }
});
