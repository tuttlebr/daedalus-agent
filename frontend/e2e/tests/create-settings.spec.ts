import {
  assertFits,
  navigate,
  openApp,
  settleTransitions,
} from '../helpers/design';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test.use({ serviceWorkers: 'block' });

async function openSettings(page: import('@playwright/test').Page) {
  const width = page.viewportSize()!.width;
  if (width < 768)
    await page.getByRole('button', { name: 'Adjust image' }).click();
  else if (width < 1024)
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return width >= 1024
    ? page.getByRole('complementary', {
        name: 'Create settings and output details',
      })
    : page.getByRole('dialog');
}

test('GIF controls persist while uploading a source and submitting image-to-GIF', async ({
  page,
}) => {
  await openApp(page);
  await navigate(page, 'Create');
  const settings = await openSettings(page);
  const format = settings.getByRole('combobox', {
    name: 'Format',
    exact: true,
  });
  await format.selectOption('gif');
  const frames = settings.getByRole('spinbutton', {
    name: 'Frames',
    exact: true,
  });
  const duration = settings.getByRole('spinbutton', {
    name: 'Frame duration (ms)',
    exact: true,
  });
  await expect(frames).toHaveValue('9');
  await expect(duration).toHaveValue('200');
  await frames.fill('3');
  await duration.fill('100');
  await expect(
    settings.getByRole('spinbutton', { name: 'Compression' }),
  ).toHaveCount(0);
  const disclosure = settings
    .locator('summary')
    .filter({ hasText: /^Settings$/ });
  await disclosure.click();
  await disclosure.click();
  await expect(frames).toHaveValue('3');
  await expect(duration).toHaveValue('100');
  await assertFits(page);
  if (page.viewportSize()!.width < 1024)
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('radio', { name: 'Edit', exact: true }).check();
  const editSettings = await openSettings(page);
  await expect(
    editSettings.getByRole('combobox', { name: 'Format', exact: true }),
  ).toHaveValue('gif');
  await expect(editSettings.locator('option[value="gif"]')).toHaveCount(1);
  await expect(
    editSettings.getByRole('spinbutton', { name: 'Frames', exact: true }),
  ).toHaveValue('3');
  await expect(
    editSettings.getByRole('spinbutton', { name: 'Frames', exact: true }),
  ).toHaveAttribute('max', '16');
  if (page.viewportSize()!.width < 1024)
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  const source = readFileSync('public/icons/icon-512x512.png');
  await page.route('**/api/session/imageStorage', (route) =>
    route.fulfill({
      json: {
        imageId: 'image-to-gif-source',
        sessionId: 'gif-test',
        mimeType: 'image/png',
      },
    }),
  );
  await page.route('**/api/session/imageStorage?*', (route) =>
    route.fulfill({ contentType: 'image/png', body: source }),
  );
  let assets = page.getByRole('tabpanel', { name: 'Create' });
  if (page.viewportSize()!.width < 768) {
    await page
      .getByRole('button', { name: 'Edit assets', exact: true })
      .click();
    assets = page.getByRole('dialog', { name: 'Edit assets' });
  }
  await assets.locator('input[type="file"][multiple]').setInputFiles({
    name: 'source.png',
    mimeType: 'image/png',
    buffer: source,
  });
  await expect(
    assets.getByRole('button', {
      name: 'Masks unavailable for GIF',
      exact: true,
    }),
  ).toBeDisabled();
  if (page.viewportSize()!.width < 768)
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/api/images/jobs*', (route) => {
    if (route.request().method() === 'POST') {
      submitted = route.request().postDataJSON();
      return route.fulfill({
        status: 202,
        json: { jobId: 'image-to-gif-test', status: 'queued' },
      });
    }
    return route.fulfill({
      json: { jobId: 'image-to-gif-test', status: 'queued', jobs: [] },
    });
  });
  await page
    .getByRole('textbox', { name: 'Describe the edit to apply' })
    .fill('Animate the supplied image with a gentle rocking motion.');
  await page.getByRole('button', { name: 'Apply edit', exact: true }).click();
  await expect
    .poll(() => submitted)
    .toMatchObject({
      mode: 'edit',
      output_format: 'gif',
      frame_count: 3,
      frame_duration_ms: 100,
      imageRefs: [
        {
          imageId: 'image-to-gif-source',
          sessionId: 'gif-test',
          mimeType: 'image/png',
        },
      ],
    });
});

test('image masks accept a single transparent pixel and reject opaque PNGs', async ({
  page,
}) => {
  await openApp(page);
  const pngs = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1024;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 1024, 1024);
    const opaque = canvas.toDataURL('image/png').split(',')[1];
    // Pixel 1 lies between the old validator's every-20th-pixel samples.
    ctx.clearRect(1, 0, 1, 1);
    return { opaque, sparse: canvas.toDataURL('image/png').split(',')[1] };
  });
  const uploads: string[] = [];
  await page.route('**/api/session/imageStorage', async (route) => {
    const payload = route.request().postDataJSON();
    uploads.push(payload.base64Data);
    await route.fulfill({
      json: {
        imageId: `image-${uploads.length}`,
        sessionId: 'mask-test',
        mimeType: 'image/png',
      },
    });
  });
  await page.route('**/api/session/imageStorage?*', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(pngs.opaque, 'base64'),
    }),
  );
  await navigate(page, 'Create');
  await page.getByRole('radio', { name: 'Edit', exact: true }).check();
  let assets = page.getByRole('tabpanel', { name: 'Create' });
  if (page.viewportSize()!.width < 768) {
    await page
      .getByRole('button', { name: 'Edit assets', exact: true })
      .click();
    assets = page.getByRole('dialog', { name: 'Edit assets' });
  }
  await assets.locator('input[type="file"][multiple]').setInputFiles({
    name: 'source.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngs.opaque, 'base64'),
  });
  await expect(
    assets.getByRole('button', { name: '+ Add mask', exact: true }),
  ).toBeEnabled();
  const mask = assets.locator('input[accept="image/png"]');
  await mask.setInputFiles({
    name: 'opaque.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngs.opaque, 'base64'),
  });
  await expect(
    assets.getByText('Mask must include transparent pixels.', { exact: true }),
  ).toBeVisible();
  expect(uploads).toEqual([pngs.opaque]);
  await mask.setInputFiles({
    name: 'sparse.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngs.sparse, 'base64'),
  });
  await expect(
    assets.getByRole('button', { name: 'Remove mask', exact: true }),
  ).toBeVisible();
  expect(uploads).toEqual([pngs.opaque, pngs.sparse]);
});

test('Create settings reflow, use equal control heights, and preserve collapsed drafts', async ({
  page,
}, testInfo) => {
  await openApp(page);
  await navigate(page, 'Create');
  const settings = await openSettings(page);
  await settleTransitions(page);
  const boxes = await settings.getByRole('combobox').evaluateAll((controls) =>
    controls.map((control) => {
      const box = control.getBoundingClientRect();
      return { height: box.height, width: box.width };
    }),
  );
  expect(boxes).toHaveLength(8);
  await expect(
    settings.getByRole('combobox', { name: 'Model', exact: true }),
  ).toHaveValue('gpt-image-2.6-sunburst');
  const complexity = settings.getByRole('combobox', {
    name: 'Complexity',
    exact: true,
  });
  await expect(complexity).toHaveValue('');
  await complexity.selectOption('low');
  // Pointer devices use the 36px control height; touch keeps 44px targets.
  const coarse = await page.evaluate(
    () => matchMedia('(pointer: coarse)').matches,
  );
  expect(Math.min(...boxes.map((box) => box.height))).toBeGreaterThanOrEqual(
    coarse ? 44 : 36,
  );
  expect(
    Math.max(...boxes.map((box) => box.height)) -
      Math.min(...boxes.map((box) => box.height)),
  ).toBeLessThan(1);
  expect(boxes[0].width).toBeGreaterThanOrEqual(boxes[1].width);
  await settings.getByRole('combobox', { name: 'Outputs' }).selectOption('2');
  await settings
    .getByRole('combobox', { name: 'Size', exact: true })
    .selectOption('custom');
  const width = settings.getByRole('spinbutton', { name: 'Image width' });
  await width.fill('1536');
  const disclosure = settings
    .locator('summary')
    .filter({ hasText: /^Settings$/ });
  await disclosure.click();
  await expect(width).toBeHidden();
  await disclosure.click();
  await expect(width).toHaveValue('1536');
  await expect(complexity).toHaveValue('low');
  await expect(settings.getByRole('combobox', { name: 'Outputs' })).toHaveValue(
    '2',
  );
  await assertFits(page);
  await page.screenshot({ path: testInfo.outputPath('create-settings.png') });
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    accessibility.violations.map((item) => ({
      id: item.id,
      nodes: item.nodes.map((node) => node.failureSummary),
    })),
  ).toEqual([]);
});

test('phone Settings keeps Done above the keyboard with safe areas and enlarged text', async ({
  page,
}, testInfo) => {
  test.skip(page.viewportSize()!.width >= 768);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 5,
    });
    // Headless browsers do not open an OS keyboard. Model its reduced visual
    // viewport while preserving the layout viewport, as on an installed PWA.
    const viewport = Object.assign(new EventTarget(), {
      height: window.innerHeight,
      width: window.innerWidth,
      offsetTop: 0,
      pageTop: 0,
      scale: 1,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });
  });
  await openApp(page);
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-area-inset-top', '62px');
    document.documentElement.style.setProperty(
      '--safe-area-inset-bottom',
      '34px',
    );
  });
  await navigate(page, 'Create');
  const trigger = page.getByRole('button', { name: 'Adjust image' });
  await trigger.click();
  const sheet = page.getByRole('dialog', { name: 'Adjust image' });
  const done = sheet.getByRole('button', { name: 'Done', exact: true });
  await sheet
    .getByRole('combobox', { name: 'Size', exact: true })
    .selectOption('custom');
  await sheet.getByRole('spinbutton', { name: 'Image width' }).fill('1536');
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 360 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(sheet).toHaveAttribute('data-keyboard-open', 'true');
  await expect
    .poll(async () => (await done.boundingBox())!.y)
    .toBeGreaterThanOrEqual(62);
  await expect
    .poll(async () => {
      const box = (await done.boundingBox())!;
      return box.y + box.height;
    })
    .toBeLessThanOrEqual(360);
  await settleTransitions(page);
  await page.screenshot({ path: testInfo.outputPath('settings-keyboard.png') });
  await done.click();
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: window.innerHeight });
    window.visualViewport!.dispatchEvent(new Event('resize'));
    document.documentElement.style.fontSize = '200%';
  });
  await trigger.click();
  await sheet
    .locator('summary')
    .filter({ hasText: /^Settings$/ })
    .click();
  const presets = sheet.locator('summary').filter({ hasText: /^Presets$/ });
  await presets.click();
  const lastPreset = sheet.getByRole('button', { name: /Product Shot/ });
  await lastPreset.scrollIntoViewIfNeeded();
  await expect(done).toBeInViewport({ ratio: 1 });
  await assertFits(page);
  await page.screenshot({
    path: testInfo.outputPath('settings-large-text.png'),
  });
  await done.click();
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('desktop sidebar collapses without losing settings or access to output actions', async ({
  page,
}, testInfo) => {
  test.skip(page.viewportSize()!.width < 1024);
  await openApp(page);
  await page.route('**/api/images/history', (route) =>
    route.fulfill({
      json: {
        history: [
          {
            id: 'creation-1',
            mode: 'generate',
            prompt: 'A mountain lake at sunrise.',
            model: 'gpt-image-2.6-sunburst',
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
  const toggle = page.getByRole('button', { name: 'Settings', exact: true });
  await page.getByRole('combobox', { name: 'Outputs' }).selectOption('2');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('combobox', { name: 'Outputs' })).toBeHidden();
  const image = page.getByRole('button', {
    name: 'Open generated image actions',
  });
  await image.click();
  const actions = page.getByRole('dialog', { name: 'Selected image actions' });
  await expect(actions).toBeVisible();
  await expect(
    actions.getByRole('button', { name: 'Continue editing' }),
  ).toBeVisible();
  await actions
    .getByRole('button', { name: 'Close selected image actions' })
    .click();
  await expect(image).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('create-collapsed.png') });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('combobox', { name: 'Outputs' })).toHaveValue(
    '2',
  );
});
