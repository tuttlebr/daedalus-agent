import { assertAuthenticatedSession } from '../helpers/auth';

import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('candidate image preserves chat, memory, and profile workflows through the real frontend', async ({
  page,
}) => {
  expect(process.env.E2E_CANDIDATE_IMAGE).toBeTruthy();
  await page.goto('/login');
  await page.getByLabel('Username').fill('e2e-user');
  await page.getByLabel('Password').fill('e2e-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/');
  await assertAuthenticatedSession(page);
  const input = page.getByPlaceholder('Send a message...');
  await input.fill('BASIC synthetic candidate clock request');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(
    page
      .getByText('The real datetime tool completed', { exact: false })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Stop generating' }),
  ).toBeHidden();
  await page.reload();
  await expect(
    page
      .getByText('The real datetime tool completed', { exact: false })
      .first(),
  ).toBeVisible();
  await input.fill('MODEL_STEER synthetic candidate cancellation request');
  await page.getByRole('button', { name: 'Send message' }).click();
  const stop = page.getByRole('button', { name: 'Stop generating' });
  await expect(stop).toBeVisible();
  const cancellation = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().includes('/api/chat/async'),
  );
  await stop.click();
  expect((await cancellation).ok()).toBeTruthy();
  await expect(stop).toBeHidden();
  await expect(input).toBeEnabled();
  await input.fill('MODEL_STEER synthetic candidate steering request');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(stop).toBeVisible();
  await page
    .getByPlaceholder('Add clarification...')
    .fill('NEW_DIRECTION: answer now');
  await page.getByRole('button', { name: 'Steer response' }).click();
  await expect(
    page.getByText('Directed answer', { exact: false }).first(),
  ).toBeVisible();
  await expect(stop).toBeHidden();
  await input.fill('WEB_SEARCH synthetic multi-query browser request');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(
    page.getByText('Web Results', { exact: true }).first(),
  ).toBeVisible();
  const searchSource = page.getByRole('link', {
    name: 'Synthetic search source 雪',
    exact: true,
  });
  await expect(searchSource.last()).toHaveAttribute(
    'href',
    'https://www.example.test/search-source',
  );
  await expect(
    page
      .getByText('2026-10-14 —Synthetic source evidence.', { exact: true })
      .first(),
  ).toBeVisible();
  await expect(stop).toBeHidden();
  await page.reload();
  await expect(
    page.getByText('Web Results', { exact: true }).first(),
  ).toBeVisible();
  await expect(searchSource.last()).toHaveAttribute(
    'href',
    'https://www.example.test/search-source',
  );
  await input.fill(
    'OUTPUT_RETRIEVAL synthetic candidate cached output request',
  );
  await page.getByRole('button', { name: 'Send message' }).click();
  const recovered =
    'Recovered exact cached output: 🌲 exact cached browser evidence';
  await expect(
    page.getByText(recovered, { exact: false }).first(),
  ).toBeVisible();
  await expect(stop).toBeHidden();
  await input.fill('USER_INTERACTION_CONFIRM synthetic browser request');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(
    page.getByText('Action requiring confirmation:', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page
      .getByText('No executable credential has been created.', { exact: false })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByText('Remove browser memories', { exact: false }).first(),
  ).toBeVisible();
  await expect(stop).toBeHidden();
  await page.reload();
  await expect(
    page.getByText('Action requiring confirmation:', { exact: true }).first(),
  ).toBeVisible();
  await input.fill('SKILL_LOAD synthetic browser skill request');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(
    page
      .getByRole('heading', { name: 'Synthetic browser instructions' })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByText('Loaded skill evidence 雪🌲', { exact: true }).first(),
  ).toBeVisible();
  await expect(stop).toBeHidden();
  await page.reload();
  await expect(
    page.getByText('Loaded skill evidence 雪🌲', { exact: true }).first(),
  ).toBeVisible();
  await input.fill('MEMORY_WRITE synthetic native memory request');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(
    page
      .getByText('Saved memory through the native tool.', { exact: false })
      .first(),
  ).toBeVisible();
  await expect(stop).toBeHidden();
  await input.fill('MEMORY_READ synthetic native recall request');
  await page.getByRole('button', { name: 'Send message' }).click();
  const memory = 'Recalled memory: Browser preference 雪🌲';
  await expect(page.getByText(memory, { exact: false }).first()).toBeVisible();
  await expect(stop).toBeHidden();
  await page.reload();
  await expect(page.getByText(memory, { exact: false }).first()).toBeVisible();
  await expect(
    page.getByText(recovered, { exact: false }).first(),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Memory Center', exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const status = await page.request.get('/api/memory/status');
      expect(status.ok()).toBeTruthy();
      return (await status.json()).counts?.completed || 0;
    })
    .toBeGreaterThan(0);
  await page.getByRole('tab', { name: 'Advanced facts' }).click();
  await expect(
    page.getByText('Synthetic original memory 雪🌲', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit memory' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit memory' });
  await editor
    .getByRole('textbox', { name: 'Memory text' })
    .fill('Browser corrected preference 雪🌲');
  await editor.getByRole('button', { name: 'Save memory' }).click();
  await expect(editor).toBeHidden();
  await expect(
    page.getByText('Browser corrected preference 雪🌲', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Clear all memory', exact: true })
    .click();
  await page
    .locator('#clear-memory-confirmation')
    .fill('DELETE ALL MY MEMORIES');
  await page.getByRole('button', { name: 'Confirm clear' }).click();
  await expect(
    page.getByText('All memories were cleared.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Browser corrected preference 雪🌲', { exact: true }),
  ).toBeHidden();
  await page.getByRole('tab', { name: 'Autonomy', exact: true }).click();
  await page.getByRole('button', { name: 'Open workspace' }).click();
  const workspace = page.getByRole('dialog', { name: 'Daedalus workspace' });
  for (const mode of ['append', 'replace']) {
    const chooser = page.waitForEvent('filechooser');
    await workspace
      .getByRole('button', { name: 'Import profile JSON' })
      .click();
    const response = page.waitForResponse(
      (reply) =>
        reply.url().includes('/api/profile/import') &&
        reply.request().method() === 'POST',
    );
    await (
      await chooser
    ).setFiles({
      name: 'synthetic-profile.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          mode,
          profile_version: 'browser-fixture',
          user_id: 'forged-user',
          entries: [
            { label: 'Browser profile', memory: 'Synthetic preference 雪🌲' },
          ],
        }),
      ),
    });
    const reply = await response;
    expect(reply.status()).toBe(mode === 'append' ? 202 : 200);
    expect(await reply.json()).toMatchObject({
      status: mode === 'append' ? 'accepted' : 'success',
      user_id: 'e2e-user',
      imported: 1,
      queued: mode === 'append' ? 1 : 0,
      profile_version: 'browser-fixture',
    });
    await expect(
      workspace.getByText(
        mode === 'append'
          ? 'Profile import accepted. Hindsight is processing 1 memory.'
          : 'Profile import completed.',
        { exact: true },
      ),
    ).toBeVisible();
  }
});

test('candidate preserves weather evidence, partial failures, and Stop through the frontend', async ({
  page,
}) => {
  const control = `http://127.0.0.1:${
    Number(process.env.E2E_MOCK_BACKEND_PORT || 18000) + 1
  }/weather`;
  await page.goto('/login');
  await page.getByLabel('Username').fill('e2e-user');
  await page.getByLabel('Password').fill('e2e-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/');
  await assertAuthenticatedSession(page);
  const input = page.getByPlaceholder('Send a message...');
  const stop = page.getByRole('button', { name: 'Stop generating' });
  for (const mode of ['complete', 'partial']) {
    expect(
      (await page.request.post(control, { data: { mode } })).ok(),
    ).toBeTruthy();
    await input.fill(`NWS_WEATHER synthetic ${mode} weather request`);
    await page.getByRole('button', { name: 'Send message' }).click();
    const expected = `Weather for Synthetic 雪🌲: 20 °C. Forecast coverage is complete. ${
      mode === 'complete'
        ? 'Synthetic alert is active.'
        : 'Alerts are unavailable.'
    }`;
    await expect(
      page.getByText(expected, { exact: true }).last(),
    ).toBeVisible();
    await expect(stop).toBeHidden();
    await page.reload();
    await expect(
      page.getByText(expected, { exact: true }).last(),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'NWS forecast', exact: true }).last(),
    ).toHaveAttribute(
      'href',
      'https://api.weather.gov/gridpoints/DTX/1,1/forecast',
    );
  }
  expect(
    (await page.request.post(control, { data: { mode: 'hold' } })).ok(),
  ).toBeTruthy();
  await input.fill('NWS_WEATHER synthetic cancellation request');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect
    .poll(async () => (await (await page.request.get(control)).json()).held)
    .toBe(1);
  await stop.click();
  await expect(stop).toBeHidden();
  await expect(input).toBeEnabled();
  await expect
    .poll(
      async () => (await (await page.request.get(control)).json()).disconnected,
    )
    .toBe(1);
  expect(
    (await page.request.post(control, { data: { mode: 'complete' } })).ok(),
  ).toBeTruthy();
});

test('candidate publishes a sandbox artifact through the frontend and preserves its owner', async ({
  page,
  playwright,
}) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('e2e-user');
  await page.getByLabel('Password').fill('e2e-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/');
  await assertAuthenticatedSession(page);
  const input = page.getByPlaceholder('Send a message...');
  for (const [marker, expected] of [
    ['SANDBOX_WRITE', 'Wrote browser artifact to its conversation workspace.'],
    ['SANDBOX_READ', 'Verified browser artifact contents.'],
    ['SANDBOX_PUBLISH', 'Published browser artifact:'],
  ]) {
    await input.fill(marker + ' synthetic artifact request');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(
      page.getByText(expected, { exact: false }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Stop generating' }),
    ).toBeHidden();
  }
  const link = page
    .getByRole('link', { name: 'browser-report.txt', exact: true })
    .last();
  await expect(link).toHaveAttribute(
    'href',
    /^\/api\/session\/documentStorage\?/,
  );
  const url = (await link.getAttribute('href'))!;
  const contents = 'Synthetic browser artifact 雪🌲\n';
  const downloaded = await page.request.get(url);
  expect(downloaded.ok()).toBeTruthy();
  expect(await downloaded.body()).toEqual(Buffer.from(contents));
  expect(downloaded.headers()['content-disposition']).toContain(
    'browser-report.txt',
  );
  expect(await page.locator('body').innerText()).not.toContain(
    'DAEDALUS_SANDBOX_ARTIFACT_REF_V1:',
  );
  await page.reload();
  await expect(link).toHaveAttribute('href', url);
  expect(await (await page.request.get(url)).body()).toEqual(
    Buffer.from(contents),
  );
  expect(await page.locator('body').innerText()).not.toContain(
    'DAEDALUS_SANDBOX_ARTIFACT_REF_V1:',
  );
  const anonymous = await playwright.request.newContext({
    ignoreHTTPSErrors: true,
  });
  try {
    expect((await anonymous.get(new URL(url, page.url()).href)).status()).toBe(
      401,
    );
  } finally {
    await anonymous.dispose();
  }
  const foreign = await page.request.post('/api/internal/sandboxArtifacts', {
    headers: {
      'content-type': 'application/octet-stream',
      'x-daedalus-internal-token': 'e2e-internal-token',
      'x-daedalus-owner-id-b64': Buffer.from('synthetic-other-owner').toString(
        'base64url',
      ),
      'x-daedalus-conversation-id-b64': Buffer.from(
        'foreign-conversation',
      ).toString('base64url'),
      'x-daedalus-artifact-path-b64': Buffer.from(
        'reports/browser-report.txt',
      ).toString('base64url'),
    },
    data: Buffer.from(contents),
  });
  expect(foreign.ok()).toBeTruthy();
  const foreignRef = (await foreign.json()).artifact;
  expect((await page.request.get(foreignRef.downloadUrl)).status()).toBe(403);
});

test('candidate extracts an S3 upload and downloads complete Markdown', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('e2e-user');
  await page.getByLabel('Password').fill('e2e-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/');
  await assertAuthenticatedSession(page);
  const contents = 'Synthetic S3 document 雪🌲 with complete content. '
    .repeat(2000)
    .trim();
  const uploaded = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/session/documentStorage'),
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: 'candidate-document.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('\uFEFF' + contents),
  });
  const response = await uploaded;
  expect(response.ok()).toBeTruthy();
  const documentRef = await response.json();
  expect(documentRef.userId).toBe('e2e-user');
  const metadataResponse = await page.request.get('/api/milvus/collections');
  expect(metadataResponse.ok()).toBeTruthy();
  expect(metadataResponse.headers()['cache-control']).toBe('private, no-store');
  const metadata = await metadataResponse.json();
  const privateName =
    'user_uploads_e2e_user_' +
    createHash('sha256').update('e2e-user').digest('hex');
  expect(metadata).toMatchObject({
    databaseName: 'synthetic-browser-database',
    userCollection: {
      name: privateName,
      displayName: 'My documents',
      scope: 'user',
      readable: true,
      writable: true,
    },
  });
  expect(metadata.writableCollections).toEqual([metadata.userCollection]);
  expect(metadata.sharedCollections).toHaveLength(5);
  expect(metadata.sharedCollections).toContainEqual({
    name: 'nvidia',
    displayName: 'nvidia',
    scope: 'shared',
    exists: true,
    readable: true,
    writable: false,
  });
  expect(JSON.stringify(metadata)).not.toContain('another_private_collection');
  const collections = page.locator('select');
  await expect(
    collections.locator('option', { hasText: 'My documents' }),
  ).toHaveCount(1);
  await collections.selectOption({ label: 'My documents' });
  await expect(collections).toHaveValue(privateName);
  await expect(collections.locator('option[value="nvidia"]')).toHaveCount(0);
  const extraction = await page.request.post('/api/document/process', {
    data: { documentRef, mode: 'extract' },
  });
  expect(extraction.ok()).toBeTruthy();
  const result = await extraction.json();
  expect(result).toMatchObject({
    success: true,
    mode: 'extract',
    filename: 'candidate-document.txt',
    pages: 1,
    truncated: true,
    originalChars: [...contents].length,
  });
  expect([...result.markdown]).toHaveLength(50000);
  expect(result.markdown).toContain(
    '[... middle omitted to fit inline document limit ...]',
  );
  await page
    .locator('select')
    .selectOption({ label: 'Read inline (skip ingest, single doc)' });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download full Markdown' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('candidate-document.md');
  expect(await file.failure()).toBeNull();
  expect(await readFile((await file.path())!, 'utf8')).toBe(contents);
});

test('candidate ingests an S3 upload through the stream worker and retains the result', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('e2e-user');
  await page.getByLabel('Password').fill('e2e-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/');
  await assertAuthenticatedSession(page);
  const contents = 'Synthetic browser ingestion 雪🌲.';
  const uploaded = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/session/documentStorage'),
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: 'candidate-ingestion.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('\uFEFF' + contents),
  });
  expect((await uploaded).ok()).toBeTruthy();
  await page.locator('select').selectOption({ label: 'My documents' });
  const control = `http://127.0.0.1:${
    Number(process.env.E2E_MOCK_BACKEND_PORT || 18000) + 1
  }/ingestion`;
  const setup = await page.request.post(control);
  expect(setup.ok()).toBeTruthy();
  const { collection } = await setup.json();
  await page
    .getByPlaceholder('Add instructions or send to ingest...')
    .fill('Ingest this synthetic document.');
  await page.getByRole('button', { name: 'Send message' }).click();
  const progress = page
    .getByRole('status')
    .filter({ hasText: 'Ingesting 1 document' });
  await expect(progress.getByRole('progressbar')).toHaveAttribute(
    'aria-valuenow',
    '42',
  );
  expect((await page.request.post(control + '/release')).ok()).toBeTruthy();
  const success = page
    .getByText('Successfully processed all 1 documents', { exact: false })
    .first();
  await expect(success).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Stop generating' }),
  ).toBeHidden();
  const evidence = await page.request.get(control);
  expect(evidence.ok()).toBeTruthy();
  const result = await evidence.json();
  expect(result.script).toEqual({ remaining: 0, errors: [] });
  expect(result.document_inserts).toBe(1);
  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0].job_payload.content).toEqual([contents]);
  expect(JSON.stringify(result.jobs[0])).toContain('embed');
  await expect(
    page.getByText(collection, { exact: false }).first(),
  ).toBeVisible();
  await page.reload();
  await expect(success).toBeVisible();
  const searchControl = control.replace('/ingestion', '/search');
  expect((await page.request.post(searchControl)).ok()).toBeTruthy();
  await page
    .getByPlaceholder('Send a message...')
    .fill('DOCUMENT_SEARCH find my newly indexed synthetic document');
  await page.getByRole('button', { name: 'Send message' }).click();
  const retrieved = page
    .getByText('Retrieved indexed document: Synthetic indexed 雪🌲', {
      exact: false,
    })
    .first();
  await expect(retrieved).toBeVisible();
  const search = await (await page.request.get(searchControl)).json();
  expect(search.searches).toHaveLength(1);
  expect(search.searches[0].collection_name).toBe(collection);
  expect(search.searches[0].guarantee_timestamp).toBe('1234');
  expect((await page.request.post(searchControl)).ok()).toBeTruthy();
  await page
    .getByPlaceholder('Send a message...')
    .fill('DOMAIN_SEARCH find a synthetic curated passage');
  await page.getByRole('button', { name: 'Send message' }).click();
  const domain = page
    .getByText('Retrieved domain passage: Synthetic indexed 雪🌲', {
      exact: false,
    })
    .first();
  await expect(domain).toBeVisible();
  const domainSearch = await (await page.request.get(searchControl)).json();
  expect(domainSearch.searches).toHaveLength(1);
  expect(domainSearch.searches[0].collection_name).toBe('nvidia');
  expect(domainSearch.searches[0].guarantee_timestamp).toBe('1');
  await page.reload();
  await expect(domain).toBeVisible();
  await expect(retrieved).toBeVisible();
  await expect(success).toBeVisible();
});
