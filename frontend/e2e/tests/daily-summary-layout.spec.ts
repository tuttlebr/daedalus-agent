import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(__dirname, '../../..');
const skill = join(root, 'skills/daily-summary');
const qaDir = mkdtempSync(join(tmpdir(), 'daily-daedalus-layout-'));

function render(name: string, edition: Record<string, unknown>) {
  const source = join(qaDir, `${name}.json`);
  writeFileSync(source, JSON.stringify(edition));
  execFileSync(
    'python3',
    [
      join(skill, 'scripts/render_daybook.py'),
      source,
      join(skill, 'references/edition-policy.json'),
      join(skill, 'assets/daybook-v4.html'),
      join(qaDir, `${name}.html`),
      join(qaDir, `${name}-coverage.json`),
    ],
    { stdio: 'pipe' },
  );
}

test.beforeAll(() => {
  const edition = JSON.parse(
    readFileSync(
      join(root, 'builder/tests/fixtures/daily_summary_dense_edition.json'),
      'utf8',
    ),
  );
  render('dense', edition);
  const embedded = structuredClone(edition);
  embedded.departments[0].stories[0].blocks.push({
    type: 'figure',
    url: 'https://example.org/test.png',
    data_url:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    source_page: 'https://example.org/image-fixture',
    credit: 'Synthetic fixture',
    alt: 'Single pixel to test offline image decoding',
    caption: 'Synthetic raster test only.',
  });
  render('embedded', embedded);
  const sparse = structuredClone(edition);
  sparse.operations_details = [];
  sparse.departments = [sparse.departments[0]];
  sparse.departments[0].stories = sparse.departments[0].stories.slice(0, 1);
  sparse.day_ahead.email_calendar.agenda = [];
  sparse.day_ahead.email_calendar.actions = [];
  sparse.day_ahead.email_calendar.lookahead = [];
  for (const item of sparse.coverage) {
    if (!['technology', 'weather', 'email-calendar'].includes(item.desk_key))
      item.status = 'quiet';
  }
  render('sparse', sparse);
  const long = structuredClone(edition);
  long.departments[0].stories[0].headline =
    'A deliberately long systems headline with a workload_identifier_that_must_wrap_without_widening_the_page_123456789';
  long.departments[0].stories[0].blocks.push({
    type: 'table',
    columns: ['Workload', 'Measured limit'],
    rows: [
      [
        'long_unbroken_identifier_'.repeat(12),
        'A long measurement label '.repeat(12),
      ],
    ],
  });
  long.day_ahead.email_calendar.actions = Array.from(
    { length: 20 },
    (_, index) => ({
      title: `Synthetic action ${index + 1}`,
      body: 'A longer calendar rail must not postpone the next news story. '.repeat(
        3,
      ),
    }),
  );
  render('long', long);
});

test.afterAll(() => rmSync(qaDir, { recursive: true, force: true }));

async function openEdition(page: Page, name = 'dense') {
  const failures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
  page.on('request', (request) => {
    if (/^https?:/.test(request.url())) failures.push(request.url());
  });
  await page.context().setOffline(true);
  await page.goto(pathToFileURL(join(qaDir, `${name}.html`)).href);
  await page.evaluate(() => document.fonts.ready);
  return failures;
}

for (const width of [1440, 1024, 768]) {
  test(`desktop newspaper flows independently at ${width}px, offline`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1100 });
    const failures = await openEdition(page);
    const geometry = await page.evaluate(() => {
      const box = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect();
      const lead = box('[data-lead-story]');
      const rail = box('[data-day-ahead]');
      const nextDesk = box('[data-department]');
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        ratio: lead.width / rail.width,
        nextStoryGap: nextDesk.top - lead.bottom,
        railTop: rail.top - lead.top,
        paper: getComputedStyle(document.body).backgroundColor,
      };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.ratio).toBeGreaterThan(1.8);
    expect(geometry.ratio).toBeLessThan(2.2);
    expect(geometry.nextStoryGap).toBeLessThanOrEqual(24);
    expect(Math.abs(geometry.railTop)).toBeLessThanOrEqual(1);
    expect(geometry.paper).toBe('rgb(255, 255, 255)');
    expect(failures).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`newspaper-${width}.png`),
      fullPage: true,
    });
  });
}

for (const width of [390, 320]) {
  test(`mobile newspaper preserves reading order at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const failures = await openEdition(page);
    const geometry = await page.evaluate(() => {
      const box = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect();
      const lead = box('[data-lead-story]');
      const rail = box('[data-day-ahead]');
      const next = box('[data-department]');
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        leadBeforeRail: lead.bottom <= rail.top,
        railBeforeDepartments: rail.bottom <= next.top,
        aligned: Math.abs(lead.left - rail.left),
      };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.leadBeforeRail).toBe(true);
    expect(geometry.railBeforeDepartments).toBe(true);
    expect(geometry.aligned).toBeLessThanOrEqual(1);
    expect(failures).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`newspaper-${width}.png`),
      fullPage: true,
    });
  });
}

for (const name of ['sparse', 'long']) {
  test(`${name} edition handles unequal content, long text and tables`, async ({
    page,
  }) => {
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const failures = await openEdition(page, name);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        ),
      ).toBeLessThanOrEqual(1);
      if (width > 740) {
        const gap = await page.evaluate(
          () =>
            document.querySelector('[data-department]')!.getBoundingClientRect()
              .top -
            document.querySelector('[data-lead-story]')!.getBoundingClientRect()
              .bottom,
        );
        expect(gap).toBeLessThanOrEqual(24);
      }
      if (name === 'long')
        await expect(
          page.getByText('Synthetic action 20', { exact: true }),
        ).toBeVisible();
      if (name === 'sparse')
        await expect(page.locator('#operations-continuation')).toHaveCount(0);
      expect(failures).toEqual([]);
    }
  });
}

test('print edition uses breakable articles and repeatable table headers', async ({
  page,
}, testInfo) => {
  await openEdition(page, 'long');
  await page.emulateMedia({ media: 'print' });
  const print = await page.evaluate(() => ({
    layout: getComputedStyle(document.querySelector('.front-page')!).display,
    article: getComputedStyle(document.querySelector('.department-story')!)
      .breakInside,
    header: getComputedStyle(document.querySelector('thead')!).display,
  }));
  expect(print).toEqual({
    layout: 'block',
    article: 'auto',
    header: 'table-header-group',
  });
  await page.pdf({
    path: testInfo.outputPath('newspaper-print.pdf'),
    format: 'Letter',
    printBackground: true,
  });
});

test('embedded source raster decodes without any external request', async ({
  page,
}) => {
  const failures = await openEdition(page, 'embedded');
  const raster = page.locator('figure img');
  await raster.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      raster.evaluate(
        (element: HTMLImageElement) =>
          element.complete && element.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await expect(page.locator('figure figcaption')).toContainText(
    'Synthetic fixture',
  );
  expect(failures).toEqual([]);
});
