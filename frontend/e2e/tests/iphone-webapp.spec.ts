import {
  assertFits,
  navigate,
  openApp,
  settleTransitions,
} from '../helpers/design';

import { devices, expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test.use({ serviceWorkers: 'block' });
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-webkit');
});

// These sizes also cover newer models sharing the same CSS screen dimensions.
const phones = [
  { name: 'iPhone 16e', screen: { width: 390, height: 844 } },
  { name: 'iPhone 16', screen: { width: 393, height: 852 } },
  { name: 'iPhone 16 Plus', screen: { width: 430, height: 932 } },
  { name: 'iPhone 16 Pro', screen: { width: 402, height: 874 } },
  { name: 'iPhone 16 Pro Max', screen: { width: 440, height: 956 } },
  { name: 'iPhone Air', screen: { width: 420, height: 912 } },
];
for (const { name: phone, screen } of phones) {
  for (const standalone of [false, true]) {
    for (const landscape of [false, true]) {
      test(`${phone} ${standalone ? 'Home Screen' : 'Safari'} ${
        landscape ? 'landscape' : 'portrait'
      } keeps navigation and typing usable`, async ({ page }, testInfo) => {
        const viewport = standalone
          ? landscape
            ? { width: screen.height, height: screen.width }
            : screen
          : devices[`${phone}${landscape ? ' landscape' : ''}`].viewport;
        await page.setViewportSize(viewport);
        await page.addInitScript((installed) => {
          Object.defineProperty(navigator, 'standalone', {
            configurable: true,
            value: installed,
          });
          localStorage.setItem('pwa-install-blocked', '1');
        }, standalone);
        await openApp(page);
        // Realistic lists make both destination pages scroll in every phone
        // orientation, so safe-area checks also cover content passing the top.
        await page.route('**/api/memory/pages', (route) =>
          route.fulfill({
            json: {
              items: Array.from({ length: 8 }, (_, index) => ({
                id: `page-${index}`,
                name: `Knowledge page ${index + 1}`,
                description:
                  'Useful details saved from previous conversations.',
                is_stale: false,
              })),
              total: 8,
            },
          }),
        );
        await page.route('**/api/google-workspace/connections', (route) =>
          route.fulfill({
            json: {
              connections: [
                'Gmail',
                'Calendar',
                'Drive',
                'Docs',
                'Sheets',
                'Tasks',
              ].map((label) => ({
                id: label.toLowerCase(),
                label,
                description: `Use ${label} from your conversations.`,
                authorizationSaved: false,
              })),
            },
          }),
        );
        const left = landscape ? 59 : 0;
        const top = standalone && !landscape ? 62 : 0;
        await page.evaluate(
          ({ left, standalone, landscape }) => {
            const style = document.documentElement.style;
            style.setProperty('--safe-area-inset-left', `${left}px`);
            style.setProperty('--safe-area-inset-right', `${left}px`);
            style.setProperty(
              '--safe-area-inset-top',
              standalone && !landscape ? '62px' : '0px',
            );
            style.setProperty(
              '--safe-area-inset-bottom',
              landscape ? '21px' : '34px',
            );
          },
          { left, standalone, landscape },
        );
        await expect
          .poll(
            async () =>
              (
                await page.locator('#main-content').boundingBox()
              )?.height,
          )
          .toBeCloseTo(viewport.height, 0);
        for (const view of [
          'Chat',
          'Create',
          'Autonomy',
          'Memory',
          'Connections',
        ]) {
          await navigate(page, view);
          await expect(
            page.getByRole('tabpanel', { name: view, exact: true }),
          ).toBeVisible();
          await assertFits(page);
          if (view === 'Memory' || view === 'Connections') {
            const panel = page.getByRole('tabpanel', {
              name: view,
              exact: true,
            });
            const scrollport = panel.locator('.app-page');
            const title = panel.getByRole('heading', { level: 1 });
            const initial = (await scrollport.boundingBox())!;
            const titleBox = (await title.boundingBox())!;
            expect(initial.y).toBeGreaterThanOrEqual(top);
            // Normal page spacing belongs below the safe region, rather than
            // being consumed by the status-bar inset.
            expect(titleBox.y - initial.y).toBeGreaterThanOrEqual(16);
            await expect
              .poll(() =>
                scrollport.evaluate((el) => el.scrollHeight - el.clientHeight),
              )
              .toBeGreaterThan(40);
            await scrollport.evaluate((el) => {
              el.scrollTop = 40;
            });
            await expect
              .poll(() => scrollport.evaluate((el) => el.scrollTop))
              .toBe(40);
            const scrolled = (await scrollport.boundingBox())!;
            expect(scrolled.y).toBeCloseTo(initial.y, 1);
            expect((await title.boundingBox())!.y).toBeLessThan(titleBox.y);
            if (top > 0) {
              // The system region must be outside the scrollport even after
              // its internal padding and heading have scrolled away.
              expect(
                await scrollport.evaluate(
                  (el, safeTop) =>
                    el.contains(
                      document.elementFromPoint(
                        window.innerWidth / 2,
                        safeTop - 1,
                      ),
                    ),
                  top,
                ),
              ).toBe(false);
            }
            await page.screenshot({
              path: testInfo.outputPath(`${view}-scrolled-safe-top.png`),
            });
            if (view === 'Memory' && !landscape) {
              const search = page.getByPlaceholder('Search Knowledge Pages');
              await search.focus();
              // iOS shrinks the visual viewport while retaining the layout
              // viewport. Model that resize, then the browser revealing input.
              await page.evaluate(() => {
                const viewport = window.visualViewport!;
                Object.defineProperty(viewport, 'height', {
                  configurable: true,
                  value: 500,
                });
                viewport.dispatchEvent(new Event('resize'));
              });
              await expect(page.locator('#main-content')).toHaveAttribute(
                'data-keyboard-open',
                'true',
              );
              await search.evaluate((el) =>
                el.scrollIntoView({ block: 'start' }),
              );
              const input = (await search.boundingBox())!;
              expect(input.y).toBeGreaterThanOrEqual(top);
              expect(input.y + input.height).toBeLessThanOrEqual(500);
              await search.blur();
              await page.evaluate(() => {
                const viewport = window.visualViewport!;
                Reflect.deleteProperty(viewport, 'height');
                viewport.dispatchEvent(new Event('resize'));
              });
              await expect(page.locator('#main-content')).toHaveAttribute(
                'data-keyboard-open',
                'false',
              );
            }
            await scrollport.evaluate((el) => {
              el.scrollTop = 0;
            });
          }
        }
        await navigate(page, 'Chat');
        const input = page.getByPlaceholder('Send a message...');
        await input.fill('Keep this draft');
        await input.press('Enter');
        await expect(input).toHaveValue('Keep this draft\n');
        const box = (await input.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(left);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - left);
        if (landscape && viewport.width >= 768) {
          expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 21);
        }
        await expect(input).toBeInViewport({ ratio: 1 });
        await expect(
          page.getByRole('button', { name: 'Send message' }),
        ).toBeInViewport({ ratio: 1 });
        await page.screenshot({ path: testInfo.outputPath('iphone-chat.png') });
      });
    }
  }
}

test('Safari explains installation while Home Screen launch suppresses it', async ({
  page,
}) => {
  await openApp(page);
  const prompt = page.getByRole('complementary', { name: 'Install Daedalus' });
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Add to Home Screen');
  await page.getByPlaceholder('Send a message...').focus();
  await expect(prompt).toBeHidden();
  await page.getByPlaceholder('Send a message...').blur();
  await expect(prompt).toBeVisible();
  await prompt
    .getByRole('button', { name: 'Dismiss install instructions' })
    .click();
  await page.reload();
  await expect(prompt).toBeHidden();
  await page.addInitScript(() => {
    localStorage.removeItem('pwa-install-dismissed');
    Object.defineProperty(navigator, 'standalone', {
      configurable: true,
      value: true,
    });
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute(
    'data-app-display-mode',
    'standalone',
  );
  await expect(prompt).toBeHidden();
});

test('a fetched Chat file saves with a fresh tap and cancellation keeps the conversation', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('pwa-install-blocked', '1');
    Object.defineProperty(navigator, 'standalone', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async ({ files }: ShareData) => {
        (window as any).__savedFile = {
          name: files![0].name,
          text: await files![0].text(),
          type: files![0].type,
          active: navigator.userActivation.isActive,
        };
        throw new DOMException('User cancelled', 'AbortError');
      },
    });
  });
  const conversation = {
    id: 'download-chat',
    name: 'Download review',
    folderId: null,
    messages: [
      {
        role: 'assistant' as const,
        content:
          '[Download report](/api/session/documentStorage?documentId=report&sessionId=sandbox-test)',
      },
    ],
  };
  await openApp(page, [conversation]);
  await page.route('**/api/session/selectedConversation', (route) =>
    route.fulfill({ json: conversation }),
  );
  await page.route('**/api/session/documentStorage?**', (route) =>
    route.fulfill({
      contentType: 'text/markdown',
      headers: { 'Content-Disposition': 'attachment; filename="report.md"' },
      body: '# Original report\n',
    }),
  );
  await page.reload();
  const originalURL = page.url();
  const downloads: string[] = [];
  page.on('download', (download) =>
    downloads.push(download.suggestedFilename()),
  );
  await page.getByRole('link', { name: 'Download report' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save file' });
  await expect(dialog).toBeVisible();
  await settleTransitions(page);
  await page.screenshot({ path: testInfo.outputPath('save-file.png') });
  expect(
    await page.evaluate(() => (window as any).__savedFile),
  ).toBeUndefined();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => (window as any).__savedFile)).toEqual({
    name: 'report.md',
    text: '# Original report\n',
    type: 'text/markdown',
    active: true,
  });
  expect(downloads).toEqual([]);
  expect(page.url()).toBe(originalURL);
  await expect(
    page.getByRole('link', { name: 'Download report' }),
  ).toBeVisible();
});

test('landscape touch controls stay visible and Chat images save their original bytes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 874, height: 402 });
  await page.addInitScript(() => {
    localStorage.setItem('pwa-install-blocked', '1');
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async ({ files }: ShareData) => {
        (window as any).__sharedImage = {
          active: navigator.userActivation.isActive,
          type: files![0].type,
          bytes: Array.from(new Uint8Array(await files![0].arrayBuffer())),
        };
      },
    });
  });
  const imageId = 'abcdef01-1234-5678-9012-abcdef012345';
  const conversation = {
    id: 'image-chat',
    name: 'Image review',
    folderId: null,
    messages: [
      {
        role: 'assistant' as const,
        content: `![Mountain lake](/api/generated-image/${imageId})`,
      },
    ],
  };
  const original = readFileSync(
    resolve(__dirname, '../../public/icons/icon-192x192.png'),
  );
  await openApp(page, [conversation]);
  await page.route('**/api/session/selectedConversation', (route) =>
    route.fulfill({ json: conversation }),
  );
  const requests: string[] = [];
  await page.route('**/api/generated-image/**', (route) => {
    requests.push(route.request().url());
    return route.fulfill({ contentType: 'image/png', body: original });
  });
  await page.reload();
  const download = page.getByRole('button', {
    name: 'Download image',
    exact: true,
  });
  await expect(download).toBeVisible();
  await settleTransitions(page);
  await expect(download.locator('..')).toHaveCSS('opacity', '1');
  const box = (await download.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  requests.length = 0;
  await download.click();
  const save = page.getByRole('dialog', { name: 'Save file' });
  await expect(save).toBeVisible();
  expect(requests.some((url) => new URL(url).search === '')).toBe(true);
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(save).toBeHidden();
  expect(await page.evaluate(() => (window as any).__sharedImage)).toEqual({
    active: true,
    type: 'image/png',
    bytes: Array.from(original),
  });
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  // Touch has no hover: every row's More button stays visible.
  const more = page.getByRole('button', { name: /^Actions for / });
  await expect(more.first()).toBeVisible();
  for (const button of await more.all())
    await expect(button).toHaveCSS('opacity', '1');
});
