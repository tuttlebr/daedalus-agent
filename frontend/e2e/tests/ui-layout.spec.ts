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

  // Installed WebKit may pan the rendered body while both Visual Viewport
  // offsets still report zero. Measure the rendered displacement directly.
  const emulatedBodyPan = 72;
  await page.evaluate((bodyPan) => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('visualViewport is unavailable');
    document.body.style.transform = `translateY(-${bodyPan}px)`;
    Object.defineProperty(viewport, 'offsetTop', {
      configurable: true,
      get: () => 0,
    });
    Object.defineProperty(viewport, 'pageTop', {
      configurable: true,
      get: () => window.scrollY,
    });
    viewport.dispatchEvent(new Event('scroll'));
  }, emulatedBodyPan);

  await expect(
    page.getByRole('navigation', { name: 'Primary navigation' }),
  ).toBeHidden();
  await expect
    .poll(() =>
      page
        .locator('#main-content')
        .evaluate((element) => element.getBoundingClientRect().top),
    )
    .toBe(0);

  const shiftedGeometry = await page.evaluate(() => {
    const main = document.getElementById('main-content');
    const composer = document.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Send a message..."]',
    );
    if (!main || !composer) throw new Error('Application shell is unavailable');
    return {
      main: main.getBoundingClientRect().toJSON(),
      composer: composer.getBoundingClientRect().toJSON(),
    };
  });
  const shiftedComposerGap = 500 - shiftedGeometry.composer.bottom;
  expect(shiftedComposerGap).toBeGreaterThanOrEqual(8);
  expect(shiftedComposerGap).toBeLessThanOrEqual(16);
});

test('mobile composer follows document scroll while the keyboard is open', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'));
  await login(page);

  const input = page.getByPlaceholder('Send a message...');
  await input.focus();
  // iOS can keep a full-height document behind the smaller visual viewport,
  // then scroll that document to reveal the focused control.
  await page.evaluate(() => {
    document.body.style.minHeight = '852px';
    document.getElementById('__next')!.style.minHeight = '852px';
  });
  await page.setViewportSize({ width: 393, height: 500 });
  await expect(page.locator('#main-content')).toHaveAttribute(
    'data-keyboard-open',
    'true',
  );
  await page.evaluate(() => {
    window.scrollTo(0, 144);
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(144);

  const geometry = () =>
    page.evaluate(() => {
      const main = document.getElementById('main-content')!;
      const composer = document.querySelector('[data-chat-input]')!;
      const input = composer.querySelector('textarea')!;
      const messages = document.querySelector('.chat-scroll-container')!;
      return {
        scrollY: window.scrollY,
        viewportHeight: window.visualViewport!.height,
        viewportOffsetTop: window.visualViewport!.offsetTop,
        viewportPageTop: window.visualViewport!.pageTop,
        appliedTranslation: getComputedStyle(main).transform,
        mainTop: main.getBoundingClientRect().top,
        composerBottom: composer.getBoundingClientRect().bottom,
        inputBottom: input.getBoundingClientRect().bottom,
        messagesBottom: messages.getBoundingClientRect().bottom,
        composerTop: composer.getBoundingClientRect().top,
      };
    });

  await expect.poll(async () => (await geometry()).mainTop).toBe(0);
  const scrolled = await geometry();
  expect(scrolled.composerBottom).toBe(scrolled.viewportHeight);
  expect(scrolled.viewportHeight - scrolled.inputBottom).toBeGreaterThanOrEqual(
    8,
  );
  expect(scrolled.viewportHeight - scrolled.inputBottom).toBeLessThanOrEqual(
    16,
  );
  expect(scrolled.messagesBottom).toBeLessThanOrEqual(scrolled.composerTop);
  await testInfo.attach('document-scroll', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  // A subsequent layout-viewport scroll need not fire visualViewport.scroll.
  await page.evaluate(() => window.scrollTo(0, 200));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(200);
  await expect.poll(async () => (await geometry()).mainTop).toBe(0);

  // Reported and rendered pan describe the same shift; neither should be
  // added twice when the document has also scrolled.
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    document.body.style.transform = 'translateY(-72px)';
    Object.defineProperty(viewport, 'offsetTop', {
      configurable: true,
      get: () => 72,
    });
    Object.defineProperty(viewport, 'pageTop', {
      configurable: true,
      get: () => window.scrollY + 72,
    });
    viewport.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(async () => (await geometry()).mainTop).toBe(0);

  // Accessory rows change the available height without requiring a fixed
  // keyboard height or another bottom inset.
  await page.setViewportSize({ width: 393, height: 420 });
  await expect.poll(async () => (await geometry()).composerBottom).toBe(420);
  const lastSuggestion = page.getByRole('button', {
    name: 'What will the weather be like today?',
  });
  await page.locator('.chat-scroll-container').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(lastSuggestion).toBeInViewport({ ratio: 1 });
  const suggestionBox = await lastSuggestion.boundingBox();
  expect(suggestionBox).not.toBeNull();
  expect(suggestionBox!.y + suggestionBox!.height).toBeLessThanOrEqual(
    (await geometry()).composerTop,
  );
  await testInfo.attach('keyboard-layout', {
    body: JSON.stringify(await geometry(), null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('keyboard-layout', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await input.blur();
  await page.evaluate(() => {
    document.body.style.minHeight = '';
    document.body.style.transform = '';
    document.getElementById('__next')!.style.minHeight = '';
    Reflect.deleteProperty(window.visualViewport!, 'offsetTop');
    Reflect.deleteProperty(window.visualViewport!, 'pageTop');
    window.scrollTo(0, 0);
  });
  await page.setViewportSize({ width: 393, height: 852 });
  await expect(page.locator('#main-content')).toHaveAttribute(
    'data-keyboard-open',
    'false',
  );
  await expect(
    page.getByRole('navigation', { name: 'Primary navigation' }),
  ).toBeVisible();
  await expect.poll(async () => (await geometry()).mainTop).toBe(0);
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
