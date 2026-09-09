import {
  assertFits,
  navigate,
  openApp,
  openSidebar,
  settleTransitions,
} from '../helpers/design';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const goals = Array.from({ length: 13 }, (_, index) => ({
  id: `goal-${index}`,
  title: `Goal ${index + 1}: Follow relevant project changes`,
  description:
    'Summarize useful changes and explain how they affect the project.',
  status: 'active',
}));

async function openWorkspace(page: import('@playwright/test').Page) {
  await openApp(page);
  await page.route('**/api/autonomy/goals', (route) =>
    route.fulfill({ json: goals }),
  );
  await navigate(page, 'Autonomy');
  await page.getByRole('button', { name: 'Open workspace' }).click();
  return page.getByRole('dialog', { name: 'Daedalus workspace' });
}

test('workspace has named fields, readable content, and access to every goal', async ({
  page,
}, testInfo) => {
  const workspace = await openWorkspace(page);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
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
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await assertFits(page);
  for (const name of [
    'Instructions (optional)',
    'Goal name',
    'Goal details (optional)',
  ]) {
    const field = workspace.getByRole('textbox', { name, exact: true });
    await field.focus();
    await expect(field).toBeInViewport();
  }
  const lastGoal = workspace.getByRole('button', {
    name: `Delete goal: ${goals[12].title}`,
  });
  await lastGoal.scrollIntoViewIfNeeded();
  await expect(lastGoal).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('workspace-large-text.png'),
  });
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Open workspace' }),
  ).toBeFocused();
});

test('Autonomy preserves failed run and goal drafts, validates schedules, and confirms deletion', async ({
  page,
}) => {
  const workspace = await openWorkspace(page);
  let fail = true;
  const requests: unknown[] = [];
  await page.route('**/api/autonomy/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: fail ? 503 : 200, json: {} });
  });
  const instruction = workspace.getByRole('textbox', {
    name: 'Instructions (optional)',
  });
  await instruction.fill('Prepare a concise project update.');
  await workspace.getByRole('button', { name: 'Send to Daedalus' }).click();
  await expect(workspace.getByRole('alert')).toContainText('Could not queue');
  await expect(instruction).toHaveValue('Prepare a concise project update.');
  fail = false;
  await workspace.getByRole('button', { name: 'Send to Daedalus' }).click();
  await expect(instruction).toHaveValue('');
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  await expect(workspace.getByRole('status')).toContainText('Run added');

  let goalFail = true;
  let deletes = 0;
  const goalWrites: unknown[] = [];
  await page.route('**/api/autonomy/goals*', async (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: goals });
    if (route.request().method() === 'DELETE') deletes++;
    if (route.request().method() === 'POST')
      goalWrites.push(route.request().postDataJSON());
    await route.fulfill({ status: goalFail ? 503 : 200, json: {} });
  });
  const title = workspace.getByRole('textbox', { name: 'Goal name' });
  await title.fill('Keep this goal draft');
  await workspace
    .getByRole('textbox', { name: 'Goal details (optional)' })
    .fill('Keep these details too');
  await workspace
    .getByRole('button', { name: 'Add goal', exact: true })
    .click();
  await expect(workspace.getByRole('alert')).toContainText('Could not create');
  await expect(title).toHaveValue('Keep this goal draft');
  goalFail = false;
  await workspace
    .getByRole('button', { name: 'Add goal', exact: true })
    .click();
  await expect(title).toHaveValue('');
  await expect(
    workspace.getByRole('textbox', { name: 'Goal details (optional)' }),
  ).toHaveValue('');
  let scheduleRequests = 0;
  await page.route('**/api/autonomy/config', (route) => {
    scheduleRequests++;
    return route.fulfill({ json: {} });
  });
  const interval = workspace.getByRole('spinbutton', {
    name: 'Run every (hours)',
  });
  await interval.fill('0');
  await workspace.getByRole('button', { name: 'Save schedule' }).click();
  expect(scheduleRequests).toBe(0);
  expect(
    await interval.evaluate(
      (el: HTMLInputElement) => el.validity.rangeUnderflow,
    ),
  ).toBe(true);
  page.once('dialog', (dialog) => dialog.dismiss());
  await workspace
    .getByRole('button', { name: `Delete goal: ${goals[0].title}` })
    .click();
  expect(deletes).toBe(0);
  page.once('dialog', (dialog) => dialog.accept());
  await workspace
    .getByRole('button', { name: `Delete goal: ${goals[0].title}` })
    .click();
  await expect.poll(() => deletes).toBe(1);
  await expect(
    workspace.getByRole('button', { name: 'Import JSON', exact: true }),
  ).toBeEnabled();
  const importFile = {
    name: 'goals.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify([{ title: 'Imported goal' }])),
  };
  const goalFileInput = workspace.locator('input[type="file"]').last();
  const beforeImport = goalWrites.length;
  page.once('dialog', (dialog) => dialog.dismiss());
  await goalFileInput.setInputFiles(importFile);
  // Reading the file is asynchronous; wait for cancellation to finish before
  // registering the next confirmation handler or selecting the same file.
  await expect(goalFileInput).toHaveValue('');
  expect(goalWrites).toHaveLength(beforeImport);
  goalFail = true;
  page.once('dialog', (dialog) => dialog.accept());
  await goalFileInput.setInputFiles(importFile);
  await expect(workspace.getByRole('alert')).toContainText(
    'Could not import goals',
  );
  expect(goalWrites[goalWrites.length - 1]).toEqual({
    mode: 'replace',
    goals: [{ title: 'Imported goal' }],
  });
  await expect(
    workspace.getByRole('button', { name: `Delete goal: ${goals[12].title}` }),
  ).toBeVisible();
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
  const row = page.getByRole('listitem').filter({
    has: page.getByRole('button', {
      name: 'Review conversation 1',
      exact: true,
    }),
  });
  await row
    .getByRole('button', { name: 'Delete conversation', exact: true })
    .click();
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
  fail = false;
  await row
    .getByRole('button', { name: 'Delete conversation', exact: true })
    .click();
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
  const row = page.getByRole('listitem').filter({
    has: page.getByRole('button', {
      name: 'Review conversation 1',
      exact: true,
    }),
  });
  await row.getByRole('button', { name: 'Rename conversation' }).click();
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

test('Autonomy reports failed cancellation and stale activity inside the visible flow', async ({
  page,
}) => {
  await openApp(page);
  await page.route('**/api/autonomy/runs', (route) =>
    route.fulfill({
      json: [{ id: 'active', status: 'running', createdAt: Date.now() }],
    }),
  );
  await page.route('**/api/autonomy/runs/active', (route) =>
    route.fulfill({ json: { events: [] } }),
  );
  await page.route('**/api/autonomy/runs/active/cancel', (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await navigate(page, 'Autonomy');
  await page.getByRole('button', { name: 'Open workspace' }).click();
  const workspace = page.getByRole('dialog', { name: 'Daedalus workspace' });
  await workspace.getByRole('button', { name: 'Cancel active run' }).click();
  await expect(workspace.getByRole('alert')).toContainText(
    'Could not cancel the run',
  );
  await expect(
    workspace.getByRole('button', { name: 'Cancel active run' }),
  ).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.route('**/api/autonomy/feed', (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(
    'Showing the last saved activity',
  );
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
    model: 'gpt-image-2.5-sunburst',
    params: {},
    inputImages: [],
    maskImage: null,
    outputImageIds: [],
    createdAt: Date.now(),
  };
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

test('long workspace queue, history, and diagnostics remain readable at enlarged text', async ({
  page,
}, testInfo) => {
  await openApp(page);
  await page.route('**/api/autonomy/queue', (route) =>
    route.fulfill({
      json: [
        {
          id: 'request-with-a-long-identifier-for-a-scheduled-project-review',
          trigger: 'manual',
          position: 1,
          requestedBy: 'Design Review',
          createdAt: Date.now(),
          prompt:
            'Review the full project plan, summarize what changed, and explain which decisions require follow-up.',
        },
      ],
    }),
  );
  await page.route('**/api/autonomy/runs', (route) =>
    route.fulfill({
      json: [
        {
          id: 'review-run',
          status: 'completed',
          createdAt: Date.now(),
          summary:
            'The project review completed with several findings that deserve further investigation.',
        },
      ],
    }),
  );
  await page.route('**/api/autonomy/runs/review-run', (route) =>
    route.fulfill({
      json: {
        events: [
          {
            id: 'event',
            type: 'autonomy.request.completed.with.findings',
            level: 'warn',
            createdAt: Date.now(),
            message:
              'Review the reported findings before starting the next request.',
          },
        ],
      },
    }),
  );
  await navigate(page, 'Autonomy');
  await page.getByRole('button', { name: 'Open workspace' }).click();
  const workspace = page.getByRole('dialog', { name: 'Daedalus workspace' });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  for (const section of ['Queue', 'History', 'Diagnostics']) {
    const summary = workspace.locator('summary').filter({ hasText: section });
    if (
      !(await summary.evaluate((el) => el.parentElement!.hasAttribute('open')))
    )
      await summary.click();
    await summary.scrollIntoViewIfNeeded();
    const details = summary.locator('..');
    expect(
      await details.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    await assertFits(page);
    await page.screenshot({
      path: testInfo.outputPath(
        `workspace-${section.toLowerCase()}-large-text.png`,
      ),
    });
  }
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
