import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test.use({ serviceWorkers: 'block' });

// Deterministic content isolates frontend behavior from personal data and live
// model services. The existing agentic suite covers authenticated integration.
async function openApp(page: Page) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/auth/me')
      body = { user: { id: 'hig', username: 'hig', name: 'Design Review' } };
    else if (path === '/api/conversations') body = [];
    else if (path === '/api/images/history') body = [];
    else if (path === '/api/memory/status') body = { total: 0, counts: {} };
    else if (path === '/api/memory/memories')
      body = {
        items: [{ id: 'fact-1', text: 'I prefer concise answers.' }],
        total: 1,
        limit: 25,
        offset: 0,
      };
    else if (path.startsWith('/api/memory/'))
      body = { items: [], total: 0, limit: 25, offset: 0 };
    else if (path === '/api/autonomy/config')
      body = { enabled: false, intervalSeconds: 14400 };
    else if (path.startsWith('/api/autonomy/')) body = [];
    else if (path === '/api/google-workspace/connections')
      body = {
        connections: [
          { id: 'gmail', label: 'Gmail', authorizationSaved: false },
          {
            id: 'calendar',
            label: 'Google Calendar',
            authorizationSaved: true,
          },
        ],
      };
    await route.fulfill({ json: body });
  });
  await page.goto('/');
  // The development indicator is not part of the shipped app.
  await page.addStyleTag({ content: 'nextjs-portal { display: none; }' });
  await expect(page.getByPlaceholder('Send a message...')).toBeVisible();
}

async function navigate(page: Page, name: string) {
  if ((page.viewportSize()?.width || 0) < 768) {
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name, exact: true })
      .click();
  } else {
    await page.getByRole('tab', { name, exact: true }).click();
  }
}

async function openSidebar(page: Page) {
  await page
    .getByRole('button', {
      name:
        (page.viewportSize()?.width || 0) < 768
          ? 'Open conversation history'
          : 'Toggle sidebar',
    })
    .click();
}

async function settleTransitions(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}

async function assertFits(page: Page) {
  const overflow = await page.evaluate(() => {
    const width = window.innerWidth;
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, h1, h2, [role="tablist"]',
      ),
    )
      .filter(
        (el) =>
          el.getClientRects().length &&
          !el.closest('[hidden]') &&
          !el.closest('[aria-hidden="true"]'),
      )
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < -1 || r.right > width + 1;
      })
      .map(
        (el) =>
          el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName,
      );
  });
  expect(overflow).toEqual([]);
}

test('appearance follows the system, respects an override, and persists', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openApp(page);
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await openSidebar(page);
  await page.getByRole('radio', { name: 'Light', exact: true }).check();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    'content',
    '#f2f2f7',
  );
});

test('destinations reflow in both appearances and at twice the text size', async ({
  page,
}, testInfo) => {
  await openApp(page);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveClass(
      colorScheme === 'dark' ? /dark/ : /^(?!.*dark)/,
    );
    for (const view of [
      'Chat',
      'Create',
      'Autonomy',
      'Memory',
      'Connections',
    ]) {
      await navigate(page, view);
      const panel = page.getByRole('tabpanel', { name: view, exact: true });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('heading', { level: 1 })).toBeVisible();
      await settleTransitions(page);
      await assertFits(page);
      const accessibility = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(
        accessibility.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            summary: n.failureSummary,
          })),
        })),
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`${view}-${colorScheme}.png`),
      });
    }
  }
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  await page.emulateMedia({ reducedMotion: 'reduce', contrast: 'more' });
  for (const view of ['Chat', 'Create', 'Autonomy', 'Memory', 'Connections']) {
    await navigate(page, view);
    await assertFits(page);
    if (view === 'Create' && (page.viewportSize()?.width || 0) < 768) {
      const adjust = await page
        .getByRole('button', { name: 'Adjust image' })
        .boundingBox();
      const submit = await page
        .locator('[data-create-actions]')
        .getByRole('button', { name: 'Create', exact: true })
        .boundingBox();
      expect(adjust).not.toBeNull();
      expect(submit).not.toBeNull();
      expect(
        adjust!.x + adjust!.width <= submit!.x ||
          adjust!.y + adjust!.height <= submit!.y,
      ).toBe(true);
      const navigation = await page
        .getByRole('navigation', { name: 'Primary navigation' })
        .boundingBox();
      expect(navigation).not.toBeNull();
      expect(submit!.y + submit!.height).toBeLessThanOrEqual(navigation!.y);
    }
    if (view === 'Memory') {
      await page
        .getByRole('button', { name: 'Clear all memory', exact: true })
        .click();
      await assertFits(page);
      await expect(
        page.getByRole('textbox', { name: /Type.*to continue/ }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    for (const input of await page.locator('textarea:visible').all()) {
      const geometry = await input.evaluate((el) => ({
        height: el.clientHeight,
        line: parseFloat(getComputedStyle(el).lineHeight),
      }));
      expect(geometry.height).toBeGreaterThanOrEqual(geometry.line);
    }
    await page.screenshot({
      path: testInfo.outputPath(`${view}-large-text.png`),
    });
  }
});

test('sheets contain keyboard focus, isolate the page, and return focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await openApp(page);
  await navigate(page, 'Create');
  const trigger = page.getByRole('button', { name: 'Adjust image' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Adjust image' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveJSProperty('open', true);
  expect(await dialog.evaluate((el) => el.matches(':modal'))).toBe(true);
  await page
    .getByRole('button', { name: 'Chat', exact: true })
    .evaluate((el: HTMLElement) => el.focus());
  expect(
    await dialog.evaluate((el) => el.contains(document.activeElement)),
  ).toBe(true);
  for (let i = 0; i < 22; i++) {
    await page.keyboard.press('Tab');
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(trigger).toBeFocused();
});

test('tab changes preserve drafts and memory state; memory editing is a modal', async ({
  page,
}) => {
  await openApp(page);
  const draft = page.getByPlaceholder('Send a message...');
  await draft.fill('A draft to return to');
  await draft.blur();
  await navigate(page, 'Memory');
  await page.getByRole('tab', { name: 'Advanced facts' }).click();
  await expect(page.getByText('I prefer concise answers.')).toBeVisible();
  await navigate(page, 'Connections');
  await navigate(page, 'Memory');
  await expect(
    page.getByRole('tab', { name: 'Advanced facts' }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Edit memory' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit memory' });
  await expect(
    editor.getByRole('textbox', { name: 'Memory text' }),
  ).toHaveValue('I prefer concise answers.');
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await navigate(page, 'Chat');
  await expect(draft).toHaveValue('A draft to return to');
  await page.setViewportSize({ width: 834, height: 1194 });
  await expect(draft).toHaveValue('A draft to return to');
  await page.setViewportSize({ width: 393, height: 852 });
  await expect(draft).toHaveValue('A draft to return to');
});

test('sign-in and offline recovery use readable appearance and named controls', async ({
  page,
}, testInfo) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  for (const url of ['/login', '/offline.html']) {
    await page.goto(url);
    await page.addStyleTag({ content: 'nextjs-portal { display: none; }' });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator('html')).toHaveClass(
        colorScheme === 'dark' ? /dark/ : /^(?!.*dark)/,
      );
      await settleTransitions(page);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(
        result.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.failureSummary),
        })),
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`${url.slice(1)}-${colorScheme}.png`),
      });
    }
  }
});

test('saved images remain visible and can continue into editing', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await openApp(page);
  await page.route('**/api/images/history', (route) =>
    route.fulfill({
      json: {
        history: [
          {
            id: 'creation-1',
            mode: 'generate',
            prompt: 'A mountain lake at sunrise.',
            model: 'gpt-image-2',
            params: { output_format: 'png' },
            inputImages: [],
            maskImage: null,
            outputImageIds: ['fixture-image'],
            createdAt: 1788810000000,
          },
        ],
      },
    }),
  );
  await page.route('**/api/generated-image/**', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: readFileSync(resolve(__dirname, '../../public/favicon.png')),
    }),
  );
  await navigate(page, 'Create');
  const image = page.getByRole('button', {
    name: 'Open generated image actions',
  });
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth),
    )
    .toBeGreaterThan(0);
  await image.click();
  const sheet = page.getByRole('dialog', { name: 'Selected image actions' });
  await expect(sheet).toBeVisible();
  await settleTransitions(page);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.failureSummary),
    })),
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('image-actions.png') });
  await sheet.getByRole('button', { name: 'Continue editing' }).click();
  await expect(sheet).toBeHidden();
  await expect(
    page.getByRole('radio', { name: 'Edit', exact: true }),
  ).toBeChecked();
  await expect(page.getByRole('button', { name: 'Apply edit' })).toBeVisible();
  await page.getByRole('button', { name: 'Adjust image' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Preserve list' }),
  ).toBeVisible();
});

test('chat photo preview supports keyboard entry, focus containment, and dismissal', async ({
  page,
}) => {
  await openApp(page);
  const conversation = {
    id: 'image-chat',
    name: 'Image review',
    folderId: null,
    messages: [
      {
        role: 'assistant',
        content:
          '![A mountain lake](/api/generated-image/abcdef01-1234-5678-9012-abcdef012345)',
      },
    ],
  };
  await page.route('**/api/session/conversationHistory', (route) =>
    route.fulfill({ json: [conversation] }),
  );
  await page.route('**/api/session/selectedConversation', (route) =>
    route.fulfill({ json: conversation }),
  );
  await page.route('**/api/generated-image/**', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: readFileSync(
        resolve(__dirname, '../../public/icons/icon-192x192.png'),
      ),
    }),
  );
  await page.reload();
  const thumbnail = page.getByRole('button', {
    name: 'A mountain lake',
    exact: true,
  });
  await expect(thumbnail).toBeVisible();
  await thumbnail.focus();
  await page.keyboard.press('Enter');
  const preview = page.getByRole('dialog', { name: 'Image preview' });
  await expect(preview).toBeVisible();
  await expect(
    preview.getByRole('img', { name: 'A mountain lake' }),
  ).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(
      await preview.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(thumbnail).toBeFocused();
  await thumbnail.press('Space');
  await preview.getByRole('button', { name: 'Close fullscreen' }).click();
  await expect(thumbnail).toBeFocused();
});
