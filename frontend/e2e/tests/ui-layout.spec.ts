import { assertAuthenticatedSession } from '../helpers/auth';

import { expect, test, type Page } from '@playwright/test';

const IPHONE_17_PRO = { width: 402, height: 874 } as const;
const IPHONE_17_PRO_LANDSCAPE = {
  width: IPHONE_17_PRO.height,
  height: IPHONE_17_PRO.width,
} as const;

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('e2e-user');
  await page.getByLabel('Password').fill('e2e-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByPlaceholder('Send a message...')).toBeVisible();
  await assertAuthenticatedSession(page);
}

async function sendMessage(page: Page, message: string) {
  await page.getByPlaceholder('Send a message...').fill(message);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(
    page.getByRole('button', { name: 'Stop generating' }),
  ).toBeHidden({ timeout: 15_000 });
}

test('real login retains its HTTPS session and service-worker control', async ({
  page,
}) => {
  await login(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => navigator.serviceWorker.controller?.scriptURL ?? null,
      ),
    )
    .toBe(`${new URL(page.url()).origin}/sw.js`);
});

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
    expect(box.x + box.width).toBeLessThanOrEqual(IPHONE_17_PRO.width);
  }

  await page.getByRole('button', { name: 'Chat' }).click();
  const input = page.getByPlaceholder('Send a message...');
  await input.focus();
  await page.setViewportSize({ width: IPHONE_17_PRO.width, height: 500 });

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
      bodyScroll: document.body.scrollTop,
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
      bodyOverflow: 'hidden',
      bodyScroll: 0,
      nextOverflow: 'hidden',
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
  expect((await viewportGeometry(page)).innerHeight).toBe(IPHONE_17_PRO.height);

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
  await page.evaluate(() => {
    window.scrollTo(0, 144);
    document.body.scrollTop = 144;
    document.getElementById('__next')!.scrollTop = 144;
  });
  await expectKeyboardFits(page, { height: 500, shifted: true });

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
    clip: { x: 0, y: 0, width: IPHONE_17_PRO.width, height: 420 },
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
  await setVisualViewport(page, IPHONE_17_PRO.height, 84);
  await expect(main).toHaveAttribute('data-keyboard-open', 'false');
  await expect
    .poll(() => viewportGeometry(page))
    .toMatchObject({
      mainTop: 0,
      mainBottom: IPHONE_17_PRO.height,
      mainHeight: IPHONE_17_PRO.height,
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

  // The correction is removed when the rendered body silently recovers, even
  // if viewport offsets stay stale and WebKit emits no final viewport event.
  await page.evaluate(() => {
    document.body.style.removeProperty('transform');
  });
  await expect
    .poll(() => viewportGeometry(page))
    .toMatchObject({
      mainTop: 0,
      mainBottom: IPHONE_17_PRO.height,
      inlineTop: '',
      viewportShifted: 'false',
      bodyOverflow: 'hidden',
      nextOverflow: 'hidden',
      textareaHit: true,
    });
  const navigation = page.getByRole('navigation', {
    name: 'Primary navigation',
  });
  const [navigationBox, recoveredMainBox] = await Promise.all([
    navigation.boundingBox(),
    main.boundingBox(),
  ]);
  expect(navigationBox).not.toBeNull();
  expect(recoveredMainBox).not.toBeNull();
  expect(navigationBox!.y + navigationBox!.height).toBeCloseTo(
    recoveredMainBox!.y + recoveredMainBox!.height,
    0,
  );

  // Repeat opening and closing: neither pan nor an old height may accumulate.
  for (const height of [480, 500]) {
    await setVisualViewport(page, IPHONE_17_PRO.height);
    await input.focus();
    await setVisualViewport(page, height);
    await expectKeyboardFits(page, { height });
    await input.blur();
    await setVisualViewport(page, IPHONE_17_PRO.height);
    await expect(main).toHaveAttribute('data-keyboard-open', 'false');
  }
});

test('mobile history drawer follows the keyboard viewport', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'));
  await login(page);
  await page.getByRole('button', { name: 'Open conversation history' }).click();

  const dialog = page.getByRole('dialog', { name: 'Navigation menu' });
  const search = page.getByRole('searchbox', { name: 'Search conversations' });
  const main = page.locator('#main-content');
  await search.focus();
  // A modal dialog is promoted to the browser's top layer, so WebKit's body
  // pan must not be added to its position. Only its visible height changes.
  await page.evaluate(() => {
    document.body.style.transform = 'translateY(-84px)';
  });
  await setVisualViewport(page, 500, 24);
  await expect(main).toHaveAttribute('data-keyboard-open', 'true');
  await expect
    .poll(() => main.evaluate((element) => (element as HTMLElement).style.top))
    .toBe('84px');
  await expect(dialog).toHaveAttribute('data-keyboard-open', 'true');
  await expect
    .poll(async () => {
      const [dialogBox, searchBox] = await Promise.all([
        dialog.boundingBox(),
        search.boundingBox(),
      ]);
      return {
        dialogTop: dialogBox?.y,
        dialogBottom: dialogBox ? dialogBox.y + dialogBox.height : null,
        dialogInlineTop: await dialog.evaluate(
          (element) => (element as HTMLElement).style.top,
        ),
        searchBottom: searchBox ? searchBox.y + searchBox.height : null,
      };
    })
    .toEqual({
      dialogTop: 0,
      dialogBottom: 500,
      dialogInlineTop: '',
      searchBottom: expect.any(Number),
    });
  const searchBox = await search.boundingBox();
  expect(searchBox).not.toBeNull();
  expect(searchBox!.y + searchBox!.height).toBeLessThanOrEqual(500);
});

test('mobile composer fits a compact keyboard viewport at 200 percent text', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'));
  await login(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });

  const input = page.getByPlaceholder('Send a message...');
  await input.focus();
  await input.fill('One\nTwo\nThree\nFour\nFive\nSix');
  await setVisualViewport(page, 350);
  await expectKeyboardFits(page, { height: 350 });

  const expectCompactComposerFits = async () => {
    const geometry = await page.evaluate(() => {
      const rect = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect();
      const main = rect('#main-content');
      const messages = rect('.chat-scroll-container');
      const composer = rect('[data-chat-input]');
      const textarea = rect('[data-chat-input] textarea');
      const attach = rect('[aria-label="Attach file"]');
      const send = rect('[aria-label="Send message"]');
      return {
        mainBottom: main.bottom,
        messagesHeight: messages.height,
        composerBottom: composer.bottom,
        textareaWidth: textarea.width,
        attach: attach.toJSON(),
        send: send.toJSON(),
        scrollWidth: document.documentElement.scrollWidth,
      };
    });

    expect(geometry.mainBottom).toBe(350);
    expect(geometry.composerBottom).toBeLessThanOrEqual(350);
    expect(geometry.messagesHeight).toBeGreaterThanOrEqual(24);
    expect(geometry.textareaWidth).toBeGreaterThanOrEqual(120);
    expect(geometry.attach.left).toBeGreaterThanOrEqual(0);
    expect(geometry.attach.bottom).toBeLessThanOrEqual(350);
    expect(geometry.send.right).toBeLessThanOrEqual(320);
    expect(geometry.send.bottom).toBeLessThanOrEqual(350);
    expect(geometry.scrollWidth).toBe(320);
  };

  await expectCompactComposerFits();
  await page.screenshot({
    path: testInfo.outputPath('compact-large-text-keyboard.png'),
    clip: { x: 0, y: 0, width: 320, height: 350 },
  });

  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
          ? input.url
          : String(input);
      if (
        url.endsWith('/api/session/imageStorage') &&
        init?.method === 'POST'
      ) {
        return new Response(
          JSON.stringify({
            imageId: 'compact-layout-image',
            sessionId: 'compact-layout-session',
            userId: 'e2e-user',
            mimeType: 'image/png',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      return nativeFetch(input, init);
    };
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'compact.png',
    mimeType: 'image/png',
    buffer: Buffer.from('layout-only-image'),
  });
  await expect(
    page.getByRole('button', { name: 'Remove attachment' }),
  ).toBeVisible();
  await expect
    .poll(() => page.getByText('compact.png', { exact: true }).count())
    .toBe(1);
  await expectKeyboardFits(page, { height: 350 });
  await expectCompactComposerFits();
  await page.screenshot({
    path: testInfo.outputPath('compact-attachment-keyboard.png'),
    clip: { x: 0, y: 0, width: 320, height: 350 },
  });

  await setVisualViewport(page, 200);
  await page.setViewportSize(IPHONE_17_PRO_LANDSCAPE);
  await expectKeyboardFits(page, { height: 200 });
  expect((await viewportGeometry(page)).mainHeight).toBe(200);
  await expect(
    page.getByRole('button', { name: 'Remove attachment' }),
  ).toBeInViewport({ ratio: 1 });
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
    .toMatchObject({ mainHeight: IPHONE_17_PRO.height, mainTop: 0 });
  await setVisualViewport(page, 500);
  await expectKeyboardFits(page, { height: 500 });

  // On rotation, iOS keeps a full landscape layout viewport behind the keyboard.
  await setVisualViewport(page, 200);
  await page.setViewportSize(IPHONE_17_PRO_LANDSCAPE);
  await expectKeyboardFits(page, { height: 200 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await input.fill('One\nTwo\nThree\nFour\nFive\nSix');
  await expectKeyboardFits(page, { height: 200 });
  expect((await viewportGeometry(page)).mainHeight).toBe(200);
  await input.blur();
  await setVisualViewport(page, IPHONE_17_PRO_LANDSCAPE.height);
  await expect(main).toHaveAttribute('data-keyboard-open', 'false');
  await expect
    .poll(() => viewportGeometry(page))
    .toMatchObject({
      mainHeight: IPHONE_17_PRO_LANDSCAPE.height,
      mainTop: 0,
    });
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
