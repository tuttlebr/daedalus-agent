import {
  assertFits,
  chooseConversationAction,
  navigate,
  openApp,
  openSidebar,
  settleTransitions,
} from '../helpers/design';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test.use({ serviceWorkers: 'block' });

test('charter settings have named fields and remain usable with enlarged text', async ({
  page,
}, testInfo) => {
  await openApp(page);
  await navigate(page, 'Autonomy');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await settleTransitions(page);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(result.violations).toEqual([]);
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  for (const name of [
    'Local interests, area, and household applicability',
    'Lighting scene',
    'Non-node LAN verification source',
  ]) {
    const field = page.getByRole('textbox', { name, exact: true });
    await field.focus();
    await expect(field).toBeInViewport();
  }
  await assertFits(page);
  await page.screenshot({
    path: testInfo.outputPath('charter-large-text.png'),
  });
});

test('charter preserves failed settings drafts and validates check intervals', async ({
  page,
}) => {
  await openApp(page);
  await navigate(page, 'Autonomy');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const preferences = page.getByRole('textbox', {
    name: 'Local interests, area, and household applicability',
  });
  await preferences.fill('Family festivals near Saline.');
  let writes = 0;
  await page.route('**/api/autonomy/config', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    writes++;
    return route.fulfill({ status: 503, json: {} });
  });
  const interval = page.getByRole('spinbutton', {
    name: 'Local calendar check interval (minutes)',
  });
  await interval.fill('0');
  await page
    .getByRole('button', { name: 'Save settings', exact: true })
    .click();
  expect(writes).toBe(0);
  await interval.fill('60');
  await page
    .getByRole('button', { name: 'Save settings', exact: true })
    .click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: /The request could not be completed/ }),
  ).toBeVisible();
  await expect(preferences).toHaveValue('Family festivals near Saline.');
});

test('Memory search rejects stale results and offers a clear path back to all facts', async ({
  page,
}) => {
  await openApp(page);
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  let slowStarted = false;
  let slowFinished = false;
  await page.route('**/api/memory/memories*', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query === 'slow') {
      slowStarted = true;
      await slow;
    }
    await route.fulfill({
      json: {
        items:
          query === 'none'
            ? []
            : [
                {
                  id: query || 'all',
                  text: query ? `Result for ${query}` : 'All saved facts',
                },
              ],
        total: query === 'none' ? 0 : 1,
        limit: 25,
        offset: 0,
      },
    });
    if (query === 'slow') slowFinished = true;
  });
  await navigate(page, 'Memory');
  await page.getByRole('tab', { name: 'Advanced facts' }).click();
  const search = page.getByRole('searchbox', { name: 'Search memories' });
  await search.fill('slow');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect.poll(() => slowStarted).toBe(true);
  await expect(page.getByRole('status')).toContainText(
    'Loading remembered facts',
  );
  await search.fill('fast');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(
    page.getByText('Result for fast', { exact: true }),
  ).toBeVisible();
  releaseSlow();
  await expect.poll(() => slowFinished).toBe(true);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(
    page.getByText('Result for fast', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Result for slow', { exact: true })).toHaveCount(
    0,
  );
  await search.fill('none');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(
    page.getByText('No results. Try another search or clear the filters.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');
  await expect(
    page.getByText('All saved facts', { exact: true }),
  ).toBeVisible();
});

test('Knowledge Pages and sources open readable dialogs and return keyboard focus', async ({
  page,
}, testInfo) => {
  await openApp(page);
  await page.route('**/api/memory/pages', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'page',
            name: 'Project decisions',
            description: 'A useful summary',
          },
        ],
        total: 1,
      },
    }),
  );
  await page.route('**/api/memory/pages/page', (route) =>
    route.fulfill({
      json: {
        id: 'page',
        name: 'Project decisions',
        body:
          '## Working preferences\n\nUse **concise answers**.\n\n' +
          'Keep useful context.\n\n'.repeat(30),
      },
    }),
  );
  await page.route('**/api/memory/sources?*', (route) =>
    route.fulfill({
      json: { items: [{ id: 'source-1' }], total: 1, limit: 25, offset: 0 },
    }),
  );
  await page.route('**/api/memory/sources/source-1', (route) =>
    route.fulfill({
      json: {
        id: 'source-1',
        original_text: 'Original conversation with a useful preference.',
      },
    }),
  );
  await navigate(page, 'Memory');
  const trigger = page.getByRole('button', { name: /Project decisions/ });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const detail = page.getByRole('dialog', {
    name: 'Knowledge Page',
    exact: true,
  });
  await expect(
    detail.getByRole('heading', { name: 'Working preferences' }),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await assertFits(page);
  await settleTransitions(page);
  expect(
    await detail
      .locator('.prose')
      .evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath('knowledge-page-large-text.png'),
  });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.getByRole('tab', { name: 'Sources', exact: true }).click();
  const source = page.getByRole('button', { name: /source-1/ });
  await source.click();
  await expect(
    page.getByRole('dialog', { name: 'Memory source' }),
  ).toContainText('Original conversation');
  await page.keyboard.press('Escape');
  await expect(source).toBeFocused();
});

const conversations = [1, 2].map((id) => ({
  id: `review-${id}`,
  name: `Review conversation ${id}`,
  messages: [],
  folderId: null,
  updatedAt: id,
}));

test('conversation selection reaches Chat and failed deletion preserves history', async ({
  page,
}) => {
  await openApp(page, conversations);
  await navigate(page, 'Memory');
  if (page.viewportSize()!.width < 768) await navigate(page, 'Chat');
  await openSidebar(page);
  await page
    .getByRole('button', { name: 'Review conversation 1', exact: true })
    .click();
  await expect(
    page.getByRole('tabpanel', { name: 'Chat', exact: true }),
  ).toBeVisible();
  if (page.viewportSize()!.width < 768) await openSidebar(page);
  let fail = true;
  await page.route('**/api/conversations/review-1', (route) =>
    route.fulfill({ status: fail ? 503 : 200, json: {} }),
  );
  await chooseConversationAction(page, 'Review conversation 1', 'Delete…');
  await page
    .getByRole('button', { name: 'Confirm delete', exact: true })
    .click();
  await expect(page.locator('.app-sidebar [role="alert"]')).toContainText(
    'It is still in your history',
  );
  await expect(
    page.getByRole('button', { name: 'Confirm delete', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel delete' }).click();
  await expect(
    page.getByRole('button', { name: 'Review conversation 1', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Actions for Review conversation 1',
      exact: true,
    }),
  ).toBeFocused();
  fail = false;
  await chooseConversationAction(page, 'Review conversation 1', 'Delete…');
  await page
    .getByRole('button', { name: 'Confirm delete', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Review conversation 1', exact: true }),
  ).toHaveCount(0);
});

test('failed rename retains the edit and a partial clear keeps failed conversations', async ({
  page,
}) => {
  await openApp(page, conversations);
  await openSidebar(page);
  let fail = true;
  await page.route('**/api/conversations/review-*', (route) =>
    route.fulfill({
      status: fail && route.request().url().endsWith('review-1') ? 503 : 200,
      json: {},
    }),
  );
  await chooseConversationAction(page, 'Review conversation 1', 'Rename');
  const name = page.getByRole('textbox', { name: 'Conversation name' });
  await name.fill('Renamed conversation');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.locator('.app-sidebar [role="alert"]')).toContainText(
    'Could not save the name',
  );
  await expect(name).toHaveValue('Renamed conversation');
  fail = false;
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(
    page.getByRole('button', { name: 'Renamed conversation', exact: true }),
  ).toBeVisible();
  fail = true;
  await page
    .getByRole('button', { name: 'Clear Conversations', exact: true })
    .click();
  await page.getByRole('button', { name: 'Confirm clear' }).click();
  await expect(page.locator('.app-sidebar [role="alert"]')).toContainText(
    'Could not delete 1 conversation',
  );
  await expect(
    page.getByRole('button', { name: 'Renamed conversation', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Review conversation 2', exact: true }),
  ).toHaveCount(0);
});

test('an app update preserves the current draft until Reload is chosen', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const worker = Object.assign(new EventTarget(), {
      state: 'installing',
      postMessage() {},
    });
    const registration = Object.assign(new EventTarget(), {
      installing: worker,
      update() {},
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: worker,
        register: async () => registration,
      },
    });
    (window as any).simulateUpdate = () => {
      registration.dispatchEvent(new Event('updatefound'));
      worker.state = 'activated';
      worker.dispatchEvent(new Event('statechange'));
    };
  });
  await openApp(page);
  const composer = page.getByPlaceholder('Send a message...');
  await composer.fill('Keep my unfinished message');
  await page.evaluate(() => (window as any).simulateUpdate());
  const update = page.getByRole('complementary', { name: 'App update' });
  await expect(update).toBeVisible();
  await assertFits(page);
  await expect(composer).toHaveValue('Keep my unfinished message');
  await update.getByRole('button', { name: 'Later' }).click();
  await expect(update).toBeHidden();
  await expect(composer).toHaveValue('Keep my unfinished message');
  await page.reload();
  await composer.fill('Reload deliberately');
  await page.evaluate(() => (window as any).simulateUpdate());
  await Promise.all([
    page.waitForEvent('load'),
    update.getByRole('button', { name: 'Reload' }).click(),
  ]);
  await expect(composer).toHaveValue('');
});

test('Connections reflows populated services and recovers a failed refresh', async ({
  page,
}, testInfo) => {
  await openApp(page);
  await navigate(page, 'Connections');
  await expect(
    page.getByRole('heading', { name: 'Gmail', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await page.emulateMedia({ contrast: 'more', reducedMotion: 'reduce' });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await settleTransitions(page);
    await assertFits(page);
    expect(
      await page
        .getByRole('tabpanel', { name: 'Connections', exact: true })
        .locator('.app-page')
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  }
  await page.screenshot({
    path: testInfo.outputPath('connections-large-text.png'),
  });
  let fail = true;
  await page.route('**/api/google-workspace/connections', (route) =>
    route.fulfill({ status: fail ? 503 : 200, json: { connections: [] } }),
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Connection status is temporarily unavailable' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Gmail', exact: true }),
  ).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByText(
      'No Google services are available yet. Use Refresh to check again.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Go to Chat', exact: true }).click();
  await expect(
    page.getByRole('tabpanel', { name: 'Chat', exact: true }),
  ).toBeVisible();
});

test('Autonomy reports failed cancellation and retains action evidence after refresh failure', async ({
  page,
}) => {
  await openApp(page);
  await page.route('**/api/autonomy/state', (route) => {
    if (route.request().method() === 'POST')
      return route.fulfill({ status: 503, json: {} });
    return route.fulfill({
      json: {
        version: 2,
        actions: {
          active: {
            id: 'active',
            kind: 'cluster_maintenance',
            responsibility: 'cluster',
            status: 'running',
            dueAt: Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            attempts: 1,
            payload: {},
            outcome: null,
          },
        },
        summaries: [],
        proposals: {},
      },
    });
  });
  await navigate(page, 'Autonomy');
  await page.getByText(/Cluster maintenance · running/).click();
  await page.getByRole('button', { name: 'Stop action', exact: true }).click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: /The request could not be completed/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Stop action', exact: true }),
  ).toBeEnabled();
  await page.route('**/api/autonomy/state', (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: /last saved activity/ }),
  ).toBeVisible();
  await expect(page.getByText(/Cluster maintenance · running/)).toBeVisible();
});

test('desktop image presets dismiss when keyboard focus leaves the popover', async ({
  page,
}) => {
  test.skip(
    page.viewportSize()!.width < 768,
    'Compact layouts use modal sheets.',
  );
  await openApp(page);
  await navigate(page, 'Create');
  await page.getByRole('button', { name: 'Presets' }).click();
  const panel = page.getByRole('dialog');
  await expect(panel).toBeVisible();
  const controls = panel.locator(
    'button:visible, select:visible, input:visible, textarea:visible',
  );
  await controls.last().focus();
  await page.keyboard.press('Tab');
  await expect(panel).toBeHidden();
});

test('saved image history survives failed deletion and clearing', async ({
  page,
}) => {
  await openApp(page);
  let fail = true;
  let deletions = 0;
  let exists = true;
  const entry = {
    id: 'saved-creation',
    mode: 'generate',
    prompt: 'A quiet mountain lake',
    model: 'gpt-image-2.6-sunburst',
    params: {},
    inputImages: [],
    maskImage: null,
    outputImageIds: ['abcdef01-1234-5678-9012-abcdef012345'],
    createdAt: Date.now(),
  };
  await page.route('**/api/generated-image/**', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: readFileSync(resolve(__dirname, '../../public/favicon.png')),
    }),
  );
  await page.route('**/api/images/history*', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { history: exists ? [entry] : [] } });
    deletions++;
    if (!fail) exists = false;
    return route.fulfill({ status: fail ? 503 : 200, json: {} });
  });
  await navigate(page, 'Create');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Session history' });
  const saved = history.getByRole('button', {
    name: 'Restore saved generate creation',
  });
  await expect(saved).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());
  await history.getByRole('button', { name: 'Delete entry' }).click();
  expect(deletions).toBe(0);
  page.once('dialog', (dialog) => dialog.accept());
  await history.getByRole('button', { name: 'Delete entry' }).click();
  await expect(history.getByRole('alert')).toContainText(
    'Your history is unchanged',
  );
  await expect(saved).toBeVisible();
  await history.getByRole('button', { name: 'Clear all history' }).click();
  await history
    .getByRole('button', { name: 'Clear history', exact: true })
    .click();
  await expect(history.getByRole('alert')).toContainText('Could not clear');
  await expect(saved).toBeVisible();
  fail = false;
  page.once('dialog', (dialog) => dialog.accept());
  await history.getByRole('button', { name: 'Delete entry' }).click();
  await expect(saved).toHaveCount(0);
});

test('a delayed Memory detail never interrupts another destination', async ({
  page,
}) => {
  await openApp(page);
  let release!: () => void;
  let started = false;
  let completed = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/memory/pages', (route) =>
    route.fulfill({
      json: { items: [{ id: 'slow-page', name: 'Slow page' }], total: 1 },
    }),
  );
  await page.route('**/api/memory/pages/slow-page', async (route) => {
    started = true;
    await pending;
    await route.fulfill({
      json: { id: 'slow-page', name: 'Slow page', body: 'A delayed result' },
    });
    completed = true;
  });
  await navigate(page, 'Memory');
  await page.getByRole('button', { name: /Slow page/ }).click();
  await expect.poll(() => started).toBe(true);
  await navigate(page, 'Create');
  release();
  await expect.poll(() => completed).toBe(true);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(
    page.getByRole('dialog', { name: 'Knowledge Page', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('tabpanel', { name: 'Create', exact: true }),
  ).toBeVisible();
});
