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
async function setVisualViewport(
  page: Page,
  height: number,
  offsetTop = 0,
  scale = 1,
  pageTop = offsetTop,
) {
  await page.evaluate(
    ({ height, offsetTop, scale, pageTop }) => {
      const viewport = window.visualViewport!;
      Object.defineProperties(viewport, {
        height: { configurable: true, get: () => height },
        offsetTop: { configurable: true, get: () => offsetTop },
        pageTop: {
          configurable: true,
          get: () => pageTop,
        },
        scale: { configurable: true, get: () => scale },
      });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    },
    { height, offsetTop, scale, pageTop },
  );
}

async function viewportGeometry(page: Page) {
  return page.evaluate(() => {
    const viewport = window.visualViewport!;
    const main = document.getElementById('main-content')!;
    const composer = document.querySelector('[data-chat-input]')!;
    const messages = document.querySelector('.chat-scroll-container')!;
    const textarea = composer.querySelector('textarea')!;
    const mainRect = main.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();
    const hit = document.elementFromPoint(
      textareaRect.left + textareaRect.width / 2,
      textareaRect.top + textareaRect.height / 2,
    );
    return {
      innerHeight: window.innerHeight,
      viewportHeight: viewport.height,
      viewportTop: viewport.offsetTop,
      viewportPageTop: viewport.pageTop,
      bodyTop: document.body.getBoundingClientRect().top,
      mainTop: mainRect.top,
      mainBottom: mainRect.bottom,
      mainHeight: mainRect.height,
      position: getComputedStyle(main).position,
      transform: getComputedStyle(main).transform,
      inlineHeight: main.style.height,
      inlineTop: main.style.top,
      viewportShifted: main.getAttribute('data-viewport-shifted'),
      composerBottom: composerRect.bottom,
      textareaBottomGap: mainRect.bottom - textareaRect.bottom,
      textareaHit:
        hit === textarea || (hit instanceof Node && textarea.contains(hit)),
      contentOverlapsComposer:
        messages.getBoundingClientRect().bottom > composerRect.top,
      bodyOverflow: getComputedStyle(document.body).overflow,
      nextOverflow: getComputedStyle(document.getElementById('__next')!)
        .overflow,
      documentScroll: window.scrollY,
      rootScroll: document.getElementById('__next')!.scrollTop,
    };
  });
}

async function expectKeyboardFits(
  page: Page,
  {
    height,
    top = 0,
    bottom = top + height,
    shifted = top > 0,
  }: { height: number; top?: number; bottom?: number; shifted?: boolean },
) {
  await expect(page.locator('#main-content')).toHaveAttribute(
    'data-keyboard-open',
    'true',
  );
  await expect
    .poll(() => viewportGeometry(page))
    .toMatchObject({
      viewportHeight: height,
      mainTop: top,
      mainBottom: bottom,
      mainHeight: height,
      position: 'absolute',
      transform: 'none',
      viewportShifted: shifted ? 'true' : 'false',
      composerBottom: bottom,
      textareaHit: true,
      contentOverlapsComposer: false,
      documentScroll: 0,
      rootScroll: 0,
    });
  const geometry = await viewportGeometry(page);
  expect(geometry.textareaBottomGap).toBeGreaterThanOrEqual(8);
  expect(geometry.textareaBottomGap).toBeLessThanOrEqual(20);
}

test('mobile keyboard resizes the visible shell without scrolling the document', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await login(page);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const heading = page.getByRole('heading', { name: 'How can I help?' });
  await expect(heading).toBeVisible();
  const input = page.getByPlaceholder('Send a message...');
  const main = page.locator('#main-content');
  await input.focus();
  await setVisualViewport(page, 500);
  await expectKeyboardFits(page, { height: 500 });
  expect((await viewportGeometry(page)).innerHeight).toBe(852);

  // There is no outer page to scroll even while the keyboard exposes a much
  // smaller area. Text input and conversation scrolling keep their own scroll.
  await page.evaluate(() => {
    window.scrollTo(0, 144);
    document.getElementById('__next')!.scrollTop = 144;
  });
  await expectKeyboardFits(page, { height: 500 });
  await input.fill('First line\nSecond line\nThird line\nFourth line');
  await expectKeyboardFits(page, { height: 500 });

  // With no rendered body movement, the standards-based pageTop positions
  // the shell within the layout viewport exactly once.
  await setVisualViewport(page, 500, 72);
  await expectKeyboardFits(page, { height: 500, top: 72 });

  // Installed WebKit can move the rendered body while its viewport APIs report
  // the same movement late or incorrectly. Body movement is an alternative
  // measurement, so the two values must never be added.
  await page.evaluate(() => {
    document.body.style.transform = 'translateY(-84px)';
  });
  await setVisualViewport(page, 500, 24);
  await expectKeyboardFits(page, { height: 500, shifted: true });
  expect((await viewportGeometry(page)).inlineTop).toBe('84px');

  // A full, correctly reported pan previously doubled to 704px, placing the
  // composer inside a clipped and untappable region. It now stays at the real
  // visible bottom and passes hit testing.
  await page.evaluate(() => {
    document.body.style.transform = 'translateY(-352px)';
  });
  await setVisualViewport(page, 500, 352);
  await expectKeyboardFits(page, { height: 500, shifted: true });
  expect((await viewportGeometry(page)).inlineTop).toBe('352px');
  const inputBox = await input.boundingBox();
  expect(inputBox).not.toBeNull();
  await page.mouse.click(
    inputBox!.x + inputBox!.width / 2,
    inputBox!.y + inputBox!.height / 2,
  );
  await expect(input).toBeFocused();

  // Once body movement has been observed, it remains authoritative while the
  // pan decreases and the accessory stack changes height. Stale larger API
  // values cannot recreate a band beneath the composer.
  await page.evaluate(() => {
    document.body.style.transform = 'translateY(-24px)';
  });
  await setVisualViewport(page, 420, 72);
  await expectKeyboardFits(page, { height: 420, shifted: true });
  expect((await viewportGeometry(page)).inlineTop).toBe('24px');
  // Safe centering collapses to top alignment when the welcome content is
  // taller than the message pane, so its beginning is never unreachable.
  await expect(heading).toBeInViewport({ ratio: 1 });
  const initialContentPosition = await page
    .locator('.chat-scroll-container')
    .evaluate((element) => ({
      scrollTop: element.scrollTop,
      paneTop: element.getBoundingClientRect().top,
      headingTop: element.querySelector('h2')!.getBoundingClientRect().top,
    }));
  expect(initialContentPosition.scrollTop).toBe(0);
  expect(initialContentPosition.headingTop).toBeGreaterThanOrEqual(
    initialContentPosition.paneTop,
  );
  const lastSuggestion = page.getByRole('button', {
    name: 'What will the weather be like today?',
  });
  await page.locator('.chat-scroll-container').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(lastSuggestion).toBeInViewport({ ratio: 1 });
  await expectKeyboardFits(page, { height: 420, shifted: true });

  await testInfo.attach('visual-viewport-layout', {
    body: JSON.stringify(await viewportGeometry(page), null, 2),
    contentType: 'application/json',
  });
  // Capture only the simulated visible region, not an invented native keyboard.
  await page.screenshot({
    path: testInfo.outputPath('keyboard-visible-region.png'),
    clip: { x: 0, y: 0, width: 393, height: 420 },
  });

  await input.blur();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expectKeyboardFits(page, { height: 420, shifted: true });

  // viewport.height can recover before WebKit releases its body pan. Keep the
  // full shell painted and tappable through that closing frame.
  await setVisualViewport(page, 852, 84);
  await expect(main).toHaveAttribute('data-keyboard-open', 'false');
  await expect
    .poll(() => viewportGeometry(page))
    .toMatchObject({
      mainTop: 0,
      mainBottom: 852,
      mainHeight: 852,
      position: 'absolute',
      transform: 'none',
      inlineHeight: '',
      inlineTop: '24px',
      viewportShifted: 'true',
      bodyOverflow: 'visible',
      nextOverflow: 'visible',
      textareaHit: true,
      documentScroll: 0,
    });
  await expect(
    page.getByRole('navigation', { name: 'Primary navigation' }),
  ).toBeVisible();

  // The correction is removed as soon as the rendered body itself recovers,
  // even if viewport offsets are still stale.
  await page.evaluate(() => {
    document.body.style.removeProperty('transform');
    window.visualViewport!.dispatchEvent(new Event('scrollend'));
  });
  await expect
    .poll(() => viewportGeometry(page))
    .toMatchObject({
      mainTop: 0,
      mainBottom: 852,
      inlineTop: '',
      viewportShifted: 'false',
      bodyOverflow: 'hidden',
      nextOverflow: 'hidden',
      textareaHit: true,
    });

  // Repeat opening and closing: neither pan nor an old height may accumulate.
  for (const height of [480, 500]) {
    await setVisualViewport(page, 852);
    await input.focus();
    await setVisualViewport(page, height);
    await expectKeyboardFits(page, { height });
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
  await expectKeyboardFits(page, { height: 500 });

  // On rotation, iOS keeps a full landscape layout viewport behind the keyboard.
  await setVisualViewport(page, 200);
  await page.setViewportSize({ width: 852, height: 393 });
  await expectKeyboardFits(page, { height: 200 });
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
