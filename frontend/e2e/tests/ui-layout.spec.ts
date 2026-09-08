import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('e2e-user');
  await page.getByLabel('Password').fill('e2e-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByPlaceholder('Send a message...')).toBeVisible();
}

async function sendMessage(page: Page, message: string) {
  await page.getByPlaceholder('Send a message...').fill(message);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(
    page.getByRole('button', { name: 'Stop generating' }),
  ).toBeHidden({ timeout: 15_000 });
}

test('mobile Create controls stay separated and the keyboard collapses navigation', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'));
  await login(page);

  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('radio', { name: 'Edit' }).click();

  const assets = page.locator('[data-mobile-edit-assets]');
  const actions = page.locator('[data-create-actions]');
  await expect(assets).toBeVisible();
  await expect(
    actions.getByRole('button', { name: 'Adjust image' }),
  ).toBeVisible();
  await expect(
    actions.getByRole('button', { name: 'Apply edit' }),
  ).toBeVisible();

  const [assetsBox, actionsBox] = await Promise.all([
    assets.boundingBox(),
    actions.boundingBox(),
  ]);
  expect(assetsBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(assetsBox!.y + assetsBox!.height).toBeLessThanOrEqual(actionsBox!.y);

  for (const button of await page.locator('button:visible').all()) {
    const box = await button.boundingBox();
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(393);
  }

  await page.getByRole('button', { name: 'Chat' }).click();
  const input = page.getByPlaceholder('Send a message...');
  await input.focus();
  await page.setViewportSize({ width: 393, height: 500 });

  await expect(
    page.getByRole('navigation', { name: 'Primary navigation' }),
  ).toBeHidden();
  const inputBox = await input.boundingBox();
  expect(inputBox).not.toBeNull();
  const composerGap = 500 - (inputBox!.y + inputBox!.height);
  expect(composerGap).toBeGreaterThanOrEqual(8);
  expect(composerGap).toBeLessThanOrEqual(16);
});

// Keep the layout viewport at its normal size, as iOS does with the keyboard.
// Do not translate the body to imitate native panning: CSS transforms change
// containing blocks, which is a different layout than the browser's viewport.
async function setVisualViewport(
  page: Page,
  height: number,
  offsetTop = 0,
  scale = 1,
) {
  await page.evaluate(
    ({ height, offsetTop, scale }) => {
      const viewport = window.visualViewport!;
      Object.defineProperties(viewport, {
        height: { configurable: true, get: () => height },
        offsetTop: { configurable: true, get: () => offsetTop },
        pageTop: {
          configurable: true,
          get: () => window.scrollY + offsetTop,
        },
        scale: { configurable: true, get: () => scale },
      });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    },
    { height, offsetTop, scale },
  );
}

async function viewportGeometry(page: Page) {
  return page.evaluate(() => {
    const viewport = window.visualViewport!;
    const main = document.getElementById('main-content')!;
    const composer = document.querySelector('[data-chat-input]')!;
    const messages = document.querySelector('.chat-scroll-container')!;
    const mainRect = main.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    return {
      innerHeight: window.innerHeight,
      viewportHeight: viewport.height,
      viewportTop: viewport.offsetTop,
      mainTop: mainRect.top,
      mainHeight: mainRect.height,
      transform: getComputedStyle(main).transform,
      composerGap: viewport.offsetTop + viewport.height - composerRect.bottom,
      contentOverlapsComposer:
        messages.getBoundingClientRect().bottom > composerRect.top,
      documentScroll: window.scrollY,
      rootScroll: document.getElementById('__next')!.scrollTop,
    };
  });
}

async function expectKeyboardFits(page: Page, height: number, top = 0) {
  await expect(page.locator('#main-content')).toHaveAttribute(
    'data-keyboard-open',
    'true',
  );
  await expect
    .poll(() => viewportGeometry(page))
    .toMatchObject({
      viewportHeight: height,
      mainTop: top,
      mainHeight: height,
      transform: 'none',
      composerGap: 0,
      contentOverlapsComposer: false,
      documentScroll: 0,
      rootScroll: 0,
    });
}

test('mobile keyboard resizes the visible shell without scrolling the document', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await login(page);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'How can I help?' }),
  ).toBeVisible();
  const input = page.getByPlaceholder('Send a message...');
  const main = page.locator('#main-content');
  await input.focus();
  await setVisualViewport(page, 500);
  await expectKeyboardFits(page, 500);
  expect((await viewportGeometry(page)).innerHeight).toBe(852);

  // There is no outer page to scroll even while the keyboard exposes a much
  // smaller area. Text input and conversation scrolling keep their own scroll.
  await page.evaluate(() => {
    window.scrollTo(0, 144);
    document.getElementById('__next')!.scrollTop = 144;
  });
  await expectKeyboardFits(page, 500);
  await input.fill('First line\nSecond line\nThird line\nFourth line');
  await expectKeyboardFits(page, 500);

  // A delayed native pan and changes to accessory height use one pair of
  // viewport bounds, without document offsets or extra keyboard padding.
  await setVisualViewport(page, 500, 72);
  await expectKeyboardFits(page, 500, 72);
  await setVisualViewport(page, 420, 72);
  await expectKeyboardFits(page, 420, 72);
  const lastSuggestion = page.getByRole('button', {
    name: 'What will the weather be like today?',
  });
  await page.locator('.chat-scroll-container').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(lastSuggestion).toBeInViewport({ ratio: 1 });
  await expectKeyboardFits(page, 420, 72);

  await testInfo.attach('visual-viewport-layout', {
    body: JSON.stringify(await viewportGeometry(page), null, 2),
    contentType: 'application/json',
  });
  // Capture only the simulated visible region, not an invented native keyboard.
  await page.screenshot({
    path: testInfo.outputPath('keyboard-visible-region.png'),
    clip: { x: 0, y: 72, width: 393, height: 420 },
  });

  await input.blur();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expectKeyboardFits(page, 420, 72);
  // iOS can report the old offset after restoring the visible height.
  await setVisualViewport(page, 852, 72);
  await expect(main).toHaveAttribute('data-keyboard-open', 'false');
  await expect
    .poll(() => viewportGeometry(page))
    .toMatchObject({
      mainTop: 0,
      mainHeight: 852,
      transform: 'none',
      documentScroll: 0,
    });
  await expect(
    page.getByRole('navigation', { name: 'Primary navigation' }),
  ).toBeVisible();

  // Repeat opening and closing: neither pan nor an old height may accumulate.
  for (const height of [480, 500]) {
    await setVisualViewport(page, 852);
    await input.focus();
    await setVisualViewport(page, height);
    await expectKeyboardFits(page, height);
    await input.blur();
    await setVisualViewport(page, 852);
    await expect(main).toHaveAttribute('data-keyboard-open', 'false');
  }
});

test('mobile viewport preserves zoom and recovers after keyboard rotation', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'));
  await login(page);
  const input = page.getByPlaceholder('Send a message...');
  const main = page.locator('#main-content');
  await input.focus();
  await setVisualViewport(page, 426, 100, 2);
  await expect(main).toHaveAttribute('data-keyboard-open', 'false');
  await expect
    .poll(() => viewportGeometry(page))
    .toMatchObject({ mainHeight: 852, mainTop: 0 });
  await setVisualViewport(page, 500);
  await expectKeyboardFits(page, 500);

  // On rotation, iOS keeps a full landscape layout viewport behind the keyboard.
  await setVisualViewport(page, 200);
  await page.setViewportSize({ width: 852, height: 393 });
  await expectKeyboardFits(page, 200);
  await input.blur();
  await setVisualViewport(page, 393);
  await expect(main).toHaveAttribute('data-keyboard-open', 'false');
  await expect
    .poll(() => viewportGeometry(page))
    .toMatchObject({ mainHeight: 393, mainTop: 0 });
});

test('fullscreen preserves HTML preview and Markdown formatting', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium');
  await login(page);

  await sendMessage(page, 'E2E_HTML');
  await expect(page.getByText('HTML preview')).toBeVisible();
  await page.getByRole('button', { name: 'View fullscreen' }).click();

  const htmlDialog = page.getByRole('dialog', { name: 'Response document' });
  await expect(htmlDialog).toBeVisible();
  const htmlFrame = htmlDialog.locator('iframe[title="HTML Preview"]');
  await expect(htmlFrame).toBeVisible();
  await expect(
    htmlFrame.contentFrame().getByRole('heading', { name: 'Formatted HTML' }),
  ).toHaveCSS('color', 'rgb(255, 0, 0)');
  await htmlDialog.getByRole('button', { name: 'Close fullscreen' }).click();

  await sendMessage(page, 'E2E_LONG_MARKDOWN');
  await expect(page.getByText('Long response')).toBeVisible();
  await page.getByRole('button', { name: 'View fullscreen' }).last().click();

  const markdownDialog = page.getByRole('dialog', {
    name: 'Response document',
  });
  await expect(
    markdownDialog.getByRole('heading', { name: 'Formatted Markdown' }),
  ).toBeVisible();
  await expect(markdownDialog.getByRole('table')).toBeVisible();
});
