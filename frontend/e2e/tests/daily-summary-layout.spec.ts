import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const currentDir = __dirname;
const root = resolve(currentDir, '../../..');
const skill = join(root, 'skills/daily-summary');
const qaDir = mkdtempSync(join(tmpdir(), 'daily-daedalus-layout-'));
const htmlPath = join(qaDir, 'daily-daedalus.html');

test.beforeAll(() => {
  execFileSync(
    'python3',
    [
      join(skill, 'scripts/render_daybook.py'),
      join(root, 'builder/tests/fixtures/daily_summary_dense_edition.json'),
      join(skill, 'references/edition-policy.json'),
      join(skill, 'assets/daybook-v4.html'),
      htmlPath,
      join(qaDir, 'coverage.json'),
    ],
    { stdio: 'pipe' },
  );
});

test.afterAll(() => {
  rmSync(qaDir, { recursive: true, force: true });
});

async function openEdition(page: Page) {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto(pathToFileURL(htmlPath).href, {
    waitUntil: 'domcontentloaded',
  });
  await page.evaluate(() => document.fonts.ready);
  return consoleErrors;
}

test('dense edition uses the front page without an empty corridor', async ({
  page,
}, testInfo) => {
  for (const viewport of [
    { width: 1440, height: 1100 },
    { width: 1024, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const consoleErrors = await openEdition(page);
    const geometry = await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>('[data-lead-grid]');
      const lead = document.querySelector<HTMLElement>(
        '[data-layout-slot="lead"]',
      );
      const dayAhead = document.querySelector<HTMLElement>(
        '[data-layout-slot="day-ahead"]',
      );
      if (!grid || !lead || !dayAhead)
        throw new Error('Front page is incomplete');
      const gridBox = grid.getBoundingClientRect();
      const leadBox = lead.getBoundingClientRect();
      const dayAheadBox = dayAhead.getBoundingClientRect();
      const leadLast = lead.lastElementChild?.getBoundingClientRect();
      const dayLast = dayAhead.lastElementChild?.getBoundingClientRect();
      return {
        columns: getComputedStyle(grid).gridTemplateColumns,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        ratio: leadBox.width / dayAheadBox.width,
        leadTail: leadLast
          ? gridBox.bottom - leadLast.bottom
          : Number.POSITIVE_INFINITY,
        dayAheadTail: dayLast
          ? gridBox.bottom - dayLast.bottom
          : Number.POSITIVE_INFINITY,
        navBorder: getComputedStyle(
          document.querySelector<HTMLElement>('[data-department-rail]')!,
        ).borderBottomStyle,
        strapDisplay: getComputedStyle(
          document.querySelector<HTMLElement>('[data-edition-strap]')!,
        ).display,
      };
    });

    expect(geometry.columns.split(' ').length).toBeGreaterThanOrEqual(2);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.ratio).toBeGreaterThan(1.2);
    expect(geometry.ratio).toBeLessThan(1.75);
    expect(geometry.leadTail).toBeLessThanOrEqual(160);
    expect(geometry.dayAheadTail).toBeLessThanOrEqual(160);
    expect(geometry.navBorder).toBe('double');
    expect(geometry.strapDisplay).toBe('flex');
    expect(consoleErrors).toEqual([]);

    await page.screenshot({
      path: testInfo.outputPath(`daily-daedalus-${viewport.width}.png`),
      fullPage: true,
    });
  }
});

test('mobile edition reflows to one ordered column', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const consoleErrors = await openEdition(page);
  const geometry = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('[data-lead-grid]')!;
    const lead = document.querySelector<HTMLElement>(
      '[data-layout-slot="lead"]',
    )!;
    const dayAhead = document.querySelector<HTMLElement>(
      '[data-layout-slot="day-ahead"]',
    )!;
    const leadBox = lead.getBoundingClientRect();
    const dayAheadBox = dayAhead.getBoundingClientRect();
    return {
      columns: getComputedStyle(grid).gridTemplateColumns,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      sameLeftEdge: Math.abs(leadBox.left - dayAheadBox.left),
      ordered: leadBox.top < dayAheadBox.top,
      navBorder: getComputedStyle(
        document.querySelector<HTMLElement>('[data-department-rail]')!,
      ).borderBottomStyle,
    };
  });

  expect(geometry.columns.split(' ')).toHaveLength(1);
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.sameLeftEdge).toBeLessThanOrEqual(1);
  expect(geometry.ordered).toBe(true);
  expect(geometry.navBorder).toBe('double');
  expect(consoleErrors).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath('daily-daedalus-390.png'),
    fullPage: true,
  });
});
