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
    // A parent's appearance transition can start another transition in an
    // inheriting child. Wait for two quiet frames after all finite effects.
    for (let quietFrames = 0; quietFrames < 2; ) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const animations = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getTiming().iterations !== Infinity &&
            animation.playState !== 'finished',
        );
      if (animations.length) {
        quietFrames = 0;
        await Promise.all(
          animations.map((animation) => animation.finished.catch(() => {})),
        );
      } else quietFrames++;
    }
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

test('populated activity stays readable and supports keyboard search and details', async ({
  page,
}, testInfo) => {
  await openApp(page);
  const step = (id: string, parent: string, name: string, type: string) => ({
    parent_id: parent,
    function_ancestry: {
      node_id: id,
      parent_id: parent,
      function_name: name,
      depth: parent === 'root' ? 0 : 1,
    },
    payload: {
      UUID: id,
      event_type: type,
      event_timestamp: 1788810000 + (parent === 'root' ? 0 : 1),
      span_event_timestamp: 1788809999,
      name,
      metadata: {
        tool_inputs: { query: 'Apple accessibility guidance' },
        tool_outputs: 'Readable text and keyboard controls.',
      },
    },
  });
  const conversation = {
    id: 'activity-review',
    name: 'Design review',
    folderId: null,
    messages: [
      {
        role: 'assistant',
        content: 'Here is the completed review.',
        intermediateSteps: [
          step('workflow', 'root', 'design_review', 'WORKFLOW_END'),
          step('search', 'workflow', 'webscrape', 'TOOL_END'),
        ],
      },
    ],
  };
  await page.route('**/api/session/conversationHistory', (route) =>
    route.fulfill({ json: [conversation] }),
  );
  await page.route('**/api/session/selectedConversation', (route) =>
    route.fulfill({ json: conversation }),
  );
  await page.reload();
  const activity = page.getByRole('button', { name: /Agent Activity/ });
  await activity.click();
  await expect(activity).toHaveAttribute('aria-expanded', 'true');
  const expand = page.getByRole('button', { name: 'Show Design Review steps' });
  await expand.focus();
  await expand.press('Space');
  await expect(
    page.getByRole('button', { name: 'Hide Design Review steps' }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const detailTrigger = page.getByRole('button', {
    name: 'View Searching the web details',
  });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveClass(
      colorScheme === 'dark' ? /dark/ : /^(?!.*dark)/,
    );
    await settleTransitions(page);
    await assertFits(page);
    let result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(result.violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`activity-${colorScheme}.png`),
    });
    await detailTrigger.focus();
    await detailTrigger.press('Enter');
    const detail = page.getByRole('dialog', {
      name: 'Searching the web details',
    });
    await expect(detail).toBeVisible();
    await expect(
      detail.getByText('Readable text and keyboard controls.'),
    ).toBeVisible();
    await detail.getByRole('button', { name: 'Advanced Details' }).click();
    await expect(
      detail.getByRole('button', { name: 'Advanced Details' }),
    ).toHaveAttribute('aria-expanded', 'true');
    await page.evaluate(
      () => (document.documentElement.style.fontSize = '200%'),
    );
    await assertFits(page);
    await settleTransitions(page);
    result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(result.violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`activity-details-${colorScheme}.png`),
    });
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
    await expect(detailTrigger).toBeFocused();
    await page.evaluate(() => (document.documentElement.style.fontSize = ''));
  }
  const search = page.getByRole('textbox', { name: 'Search activity' });
  await search.fill('no matching activity');
  await expect(
    page.getByText('No activity matches your search.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear activity search' }).click();
  await expect(search).toBeFocused();
  await expect(detailTrigger).toBeVisible();
  await search.blur();
  await openSidebar(page);
  const history = page.getByRole('navigation', {
    name: 'Conversation history',
  });
  await expect(
    history.getByRole('button', { name: 'Design review', exact: true }),
  ).toHaveAttribute('aria-current', 'true');
  const rename = history.getByRole('button', { name: 'Rename conversation' });
  await rename.focus();
  await settleTransitions(page);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
  await rename.press('Enter');
  await expect(
    page.getByRole('textbox', { name: 'Conversation name' }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Conversation name' })
    .press('Escape');
  await expect(
    history.getByRole('button', { name: 'Design review', exact: true }),
  ).toBeVisible();
  await expect(rename).toBeFocused();
});

test('populated Autonomy groups support appearance, text scaling, and scoped keyboard navigation', async ({
  page,
}, testInfo) => {
  await openApp(page);
  await page.route('**/api/autonomy/feed', (route) =>
    route.fulfill({
      json: [
        {
          id: 'feed-1',
          runId: 'run-1',
          lane: 'known',
          title: 'Make reading comfortable',
          bluf: 'Text should remain legible in both appearances.',
          body: 'Use semantic colors and text that scales with browser preferences.',
          confidence: 'medium',
          confidenceReason: 'Check on a physical device.',
          createdAt: Date.now(),
          sourceUrl:
            'https://developer.apple.com/design/human-interface-guidelines/accessibility',
        },
      ],
    }),
  );
  await navigate(page, 'Autonomy');
  const item = page.getByRole('article', { name: 'Make reading comfortable' });
  const title = item.getByRole('button', { name: 'Make reading comfortable' });
  await title.focus();
  await title.press('Enter');
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  await expect(
    item.getByText(
      'Use semantic colors and text that scales with browser preferences.',
    ),
  ).toBeVisible();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveClass(
      colorScheme === 'dark' ? /dark/ : /^(?!.*dark)/,
    );
    await settleTransitions(page);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(result.violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`autonomy-populated-${colorScheme}.png`),
    });
  }
  const fontSize = await title.evaluate((el) =>
    parseFloat(getComputedStyle(el).fontSize),
  );
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  await expect
    .poll(() =>
      title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    )
    .toBe(fontSize * 2);
  await assertFits(page);
  await page.screenshot({
    path: testInfo.outputPath('autonomy-populated-large-text.png'),
  });
  await page.evaluate(() => (document.documentElement.style.fontSize = ''));
  const all = page.getByRole('radio', { name: 'All 1', exact: true });
  await all.focus();
  await all.press('End');
  const scout = page.getByRole('radio', { name: 'Scout 0', exact: true });
  await expect(scout).toHaveAttribute('aria-checked', 'true');
  await scout.press('Home');
  await expect(all).toHaveAttribute('aria-checked', 'true');
  await title.press('j');
  await expect(item).toBeFocused();
  await navigate(page, 'Chat');
  const chatNavigation =
    page.viewportSize()!.width < 768
      ? page
          .getByRole('navigation', { name: 'Primary navigation' })
          .getByRole('button', { name: 'Chat', exact: true })
      : page.getByRole('tab', { name: 'Chat', exact: true });
  await chatNavigation.focus();
  await chatNavigation.press('j');
  await expect(chatNavigation).toBeFocused();
});

test('memory save errors remain in the editor with the draft available to retry', async ({
  page,
}) => {
  await openApp(page);
  await navigate(page, 'Memory');
  await page.getByRole('tab', { name: 'Advanced facts' }).click();
  await page.getByRole('button', { name: 'Edit memory' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit memory' });
  const text = editor.getByRole('textbox', { name: 'Memory text' });
  await text.fill('Keep my revised memory.');
  await page.route('**/api/memory/memories/fact-1', (route) =>
    route.fulfill({
      status: 503,
      json: { error: 'Memory is temporarily unavailable. Please retry.' },
    }),
  );
  await editor.getByRole('button', { name: 'Save memory' }).click();
  await expect(editor.getByRole('alert')).toHaveText(
    'Memory is temporarily unavailable. Please retry.',
  );
  await expect(text).toHaveValue('Keep my revised memory.');
  await expect(text).toHaveAccessibleDescription(
    'Memory is temporarily unavailable. Please retry.',
  );
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  await assertFits(page);
  await page.route('**/api/memory/memories/fact-1', async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      text: 'Keep my revised memory.',
    });
    await route.fulfill({ json: {} });
  });
  await editor.getByRole('button', { name: 'Save memory' }).click();
  await expect(editor).toBeHidden();
  await expect(
    page.getByRole('status').filter({ hasText: 'Memory updated.' }),
  ).toBeVisible();
});

test('custom image dimensions have persistent labels and recoverable validation', async ({
  page,
}, testInfo) => {
  await openApp(page);
  await navigate(page, 'Create');
  const width = page.viewportSize()!.width;
  if (width < 768)
    await page.getByRole('button', { name: 'Adjust image' }).click();
  else if (width < 1024)
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Size', exact: true })
    .selectOption('custom');
  const imageWidth = page.getByRole('spinbutton', { name: 'Image width' });
  const imageHeight = page.getByRole('spinbutton', { name: 'Image height' });
  await imageWidth.fill('17');
  await imageHeight.fill('2048');
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  await apply.click();
  await expect(imageWidth).toHaveAttribute('aria-invalid', 'true');
  await expect(imageWidth).toHaveValue('17');
  const validation = page
    .getByRole('alert')
    .filter({ hasText: /Width and height/ });
  await expect(validation).toBeVisible();
  await imageWidth.fill('2048');
  await apply.click();
  await expect(imageWidth).toHaveAttribute('aria-invalid', 'false');
  await expect(validation).toHaveCount(0);
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  await settleTransitions(page);
  await assertFits(page);
  if (width >= 768 && width < 1024) {
    await page.setViewportSize({ width: 780, height: 1194 });
    await settleTransitions(page);
    await assertFits(page);
  }
  await apply.scrollIntoViewIfNeeded();
  await settleTransitions(page);
  await page.screenshot({
    path: testInfo.outputPath('custom-size-large-text.png'),
  });
});
