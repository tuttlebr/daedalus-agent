import { branding } from '../../generated/branding';

import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('upgrades old icon caches and uses versioned branding online and offline', async ({
  page,
  context,
  request,
}) => {
  await page.goto('/login');
  await expect(
    page.getByRole('img', { name: 'Daedalus', exact: true }),
  ).toHaveAttribute('src', branding.assets['/favicon.png']);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    branding.manifest,
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'href',
    branding.assets['/icons/icon-180x180.png'],
  );

  // Seed the two buckets used by the previous release, then reinstall the
  // production worker to exercise activation and cache migration in a browser.
  await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations.map((registration) => registration.unregister()),
    );
  });
  // A new document sheds any controller from the unregistered worker.
  await page.goto('/offline.html');
  await page.evaluate(async () => {
    const old = await caches.open('daedalus-v2');
    const runtime = await caches.open('daedalus-runtime');
    await old.put('/icons/icon-192x192.png', new Response('OLD_INSTALL'));
    await runtime.put('/icons/icon-192x192.png', new Response('OLD_RUNTIME'));
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => resolve(),
          { once: true },
        ),
      );
    }
  });
  await expect
    .poll(() => page.evaluate(() => caches.keys()))
    .not.toContain('daedalus-v2');

  const manifestResponse = await request.get(branding.manifest);
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.id).toBe('/daedalus-v2');
  for (const icon of [...manifest.icons, ...manifest.shortcuts[0].icons]) {
    expect(icon.src).toEqual(
      branding.assets[icon.src.split('?')[0] as keyof typeof branding.assets],
    );
  }

  // Verify the URL hash against the actual served bytes for every branding PNG.
  for (const [file, url] of Object.entries(branding.assets)) {
    const response = await request.get(url);
    expect(response.ok()).toBeTruthy();
    const bytes = await response.body();
    expect(bytes).toEqual(readFileSync(resolve('public', file.slice(1))));
    expect(url).toContain(
      createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    );
  }

  const iconUrl = branding.assets['/icons/icon-192x192.png'];
  const iconBytes = [...readFileSync(resolve('public/icons/icon-192x192.png'))];
  const fetchBytes = (url: string) =>
    page.evaluate(
      async (url) => [
        ...new Uint8Array(await (await fetch(url)).arrayBuffer()),
      ],
      url,
    );
  expect(await fetchBytes('/icons/icon-192x192.png')).toEqual(iconBytes);

  // The former bug kept returning a stale precache even after background refresh.
  const cacheName = `daedalus-v3-${branding.version}`;
  await page.evaluate(
    async ({ cacheName, iconUrl }) => {
      await (await caches.open(cacheName)).put(iconUrl, new Response('STALE'));
    },
    { cacheName, iconUrl },
  );
  expect(
    await page.evaluate(async (url) => (await fetch(url)).text(), iconUrl),
  ).toBe('STALE');
  await expect
    .poll(() =>
      page.evaluate(
        async ({ cacheName, iconUrl }) => {
          const response = await (await caches.open(cacheName)).match(iconUrl);
          return response ? (await response.arrayBuffer()).byteLength : 0;
        },
        { cacheName, iconUrl },
      ),
    )
    .toBe(iconBytes.length);

  await context.setOffline(true);
  expect(await fetchBytes(iconUrl)).toEqual(iconBytes);
  expect(await fetchBytes('/icons/icon-192x192.png')).toEqual(iconBytes);
  const offlineHtml = await page.evaluate(async () =>
    (await fetch('/offline.html')).text(),
  );
  expect(offlineHtml).toContain(branding.assets['/icons/icon-96x96.png']);
});
