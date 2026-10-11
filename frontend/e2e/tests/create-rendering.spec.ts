import { assertAuthenticatedSession } from '../helpers/auth';
import { navigate } from '../helpers/design';

import { expect, test as base, type Page } from '@playwright/test';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

type ImageJob = {
  jobId: string;
  sessionId: string;
  mode: string;
  status: string;
  prompt: string;
  model: string;
  params: Record<string, unknown>;
  inputImages: unknown[];
  maskImage: null;
  partialImageIds: string[];
  outputImageIds: string[];
  createdAt: number;
};

const test = base.extend<{ imageIds: string[] }>({
  imageIds: async ({}, provide) => {
    const redis = new Redis(
      process.env.E2E_REDIS_URL ||
        'redis://default:e2e-redis-password@127.0.0.1:16379',
    );
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    try {
      for (const [index, id] of ids.entries()) {
        const image = await readFile(
          `public/icons/icon-512x512${index === 2 ? '-maskable' : ''}.png`,
        );
        await redis.set(
          `generated:image:${id}`,
          JSON.stringify({
            data: image.toString('base64'),
            mimeType: 'image/png',
            userId: 'e2e-user',
          }),
          'EX',
          180,
        );
      }
      await provide(ids);
    } finally {
      await redis.del(...ids.map((id) => `generated:image:${id}`));
      await redis.quit();
    }
  },
});

test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page, context }) => {
  const login = await context.request.post('/api/auth/login', {
    data: { username: 'e2e-user', password: 'e2e-password' },
  });
  expect(login.status()).toBe(200);
  await page.goto('/');
  await assertAuthenticatedSession(page);
});

function jobState(): ImageJob {
  return {
    jobId: randomUUID(),
    sessionId: 'fixture',
    mode: 'generate',
    status: 'running',
    prompt: 'Create rendering fixture',
    model: 'gpt-image-2.5-sunburst',
    params: { n: 1, output_format: 'png' },
    inputImages: [],
    maskImage: null,
    partialImageIds: [],
    outputImageIds: [],
    createdAt: Date.now(),
  };
}

async function currentImageSrc(
  page: Page,
  selector: string,
): Promise<string | null> {
  return page.locator(selector).evaluateAll((images) => {
    const image = images.find(
      (el) =>
        getComputedStyle(el).visibility === 'visible' &&
        getComputedStyle(el).opacity === '1',
    ) as HTMLImageElement | undefined;
    return image && image.complete && image.naturalWidth > 0 ? image.src : null;
  });
}

test('Create keeps one evolving preview through slow polling and final decoding', async ({
  page,
  imageIds,
}) => {
  const job = jobState();
  let submitted = false;
  let statusRequests = 0;
  let releaseFinal!: () => void;
  const finalGate = new Promise<void>((resolve) => {
    releaseFinal = resolve;
  });
  let finalRequested = false;
  await page.route('**/api/images/history*', (route) =>
    route.fulfill({ json: { history: [] } }),
  );
  await page.route('**/api/images/jobs*', async (route) => {
    if (route.request().method() === 'POST') {
      submitted = true;
      await route.fulfill({ json: { jobId: job.jobId } });
      return;
    }
    statusRequests++;
    const value = route.request().url().includes('active=1')
      ? { jobs: submitted && job.status === 'running' ? [{ ...job }] : [] }
      : { ...job };
    // Slower than the 500 ms elapsed-time render. Renders must not cancel polls.
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.fulfill({ json: value });
  });
  await page.route(
    `**/api/generated-image/${imageIds[2]}?thumbnail=true`,
    async (route) => {
      finalRequested = true;
      await finalGate;
      await route.continue();
    },
  );
  try {
    await navigate(page, 'Create');
    await page
      .getByRole('textbox', { name: 'Describe an image to create' })
      .fill(job.prompt);
    await page
      .getByRole('tabpanel', { name: 'Create' })
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    job.partialImageIds = [imageIds[0]];
    const tiles = page.getByRole('button', {
      name: 'Open generated image actions',
    });
    const selector = 'button[aria-label="Open generated image actions"] img';
    await expect.poll(() => currentImageSrc(page, selector)).not.toBeNull();
    const first = await currentImageSrc(page, selector);
    await expect(tiles).toHaveCount(1);
    await expect(tiles).toBeDisabled();

    job.partialImageIds = imageIds.slice(0, 2);
    await expect
      .poll(async () => {
        const src = await currentImageSrc(page, selector);
        return src !== null && src !== first;
      })
      .toBe(true);
    await expect(tiles).toHaveCount(1);
    const preview = await currentImageSrc(page, selector);
    job.status = 'completed';
    job.outputImageIds = [imageIds[2]];
    await expect.poll(() => finalRequested).toBe(true);
    await expect(
      page.getByText('Loading final image', { exact: true }),
    ).toBeVisible();
    expect(await currentImageSrc(page, selector)).toBe(preview);
    await expect(tiles).toBeDisabled();
    releaseFinal();
    await expect(tiles).toBeEnabled();
    await expect(tiles.locator('img')).toHaveCount(1);
    expect(await currentImageSrc(page, selector)).not.toBe(preview);
    expect(statusRequests).toBeLessThan(10);
  } finally {
    releaseFinal();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('an open mobile result sheet replaces its image and contains the entire final', async ({
  page,
  imageIds,
}) => {
  await page.setViewportSize({ width: 402, height: 874 });
  const job = jobState();
  await page.route('**/api/images/history*', (route) =>
    route.fulfill({
      json: {
        history: [
          {
            ...job,
            id: 'previous-final',
            prompt: 'Previous completed image',
            outputImageIds: [imageIds[0]],
          },
        ],
      },
    }),
  );
  await page.route('**/api/images/jobs*', async (route) => {
    const value = route.request().url().includes('active=1')
      ? { jobs: job.status === 'running' ? [{ ...job }] : [] }
      : { ...job };
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.fulfill({ json: value });
  });
  try {
    await navigate(page, 'Create');
    const tile = page.getByRole('button', {
      name: 'Open generated image actions',
    });
    await expect(tile).toBeEnabled();
    await tile.click();
    const sheet = page.getByRole('dialog', { name: 'Selected image actions' });
    await expect(sheet).toBeVisible();
    await expect.poll(() => currentImageSrc(page, 'dialog img')).not.toBeNull();
    const previous = await currentImageSrc(page, 'dialog img');
    job.status = 'completed';
    job.outputImageIds = [imageIds[2]];
    await expect(
      sheet.getByText(job.prompt, { exact: true }).first(),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const src = await currentImageSrc(page, 'dialog img');
        return src !== null && src !== previous;
      })
      .toBe(true);
    const dimensions = await sheet.locator('img').evaluate((image) => ({
      imageHeight: image.getBoundingClientRect().height,
      wrapperHeight: image.parentElement!.getBoundingClientRect().height,
    }));
    expect(dimensions.imageHeight).toBeLessThanOrEqual(
      dimensions.wrapperHeight,
    );
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});
