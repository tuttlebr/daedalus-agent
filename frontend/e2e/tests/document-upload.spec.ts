import { assertAuthenticatedSession } from '../helpers/auth';

import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

test('uploads a selected PDF under service-worker control and retrieves every byte', async ({
  page,
}, testInfo) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('e2e-user');
  await page.getByLabel('Password').fill('e2e-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByPlaceholder('Send a message...')).toBeVisible();
  await assertAuthenticatedSession(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
    )
    .toContain('/sw.js');

  // Select a real file from disk, as Safari's Files picker does. A File made
  // from Playwright's in-memory buffer does not exercise this source path.
  const filename = 'upload-文档.pdf';
  const filePath = testInfo.outputPath(filename);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 4\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}`;
  pdf += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = Buffer.from(pdf);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);

  const uploadResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/session/documentStorage'),
  );
  await page.locator('input[type="file"]').setInputFiles(filePath);
  const uploaded = await uploadResponse;
  expect(await uploaded.text()).not.toContain('Content-Length is invalid');
  expect(uploaded.status()).toBe(200);
  const reference = await uploaded.json();
  expect(reference.userId).toBe('e2e-user');
  await expect(page.getByText(filename, { exact: true }).last()).toBeVisible();

  const stored = await page.evaluate(async ({ documentId, sessionId }) => {
    const url = `/api/session/documentStorage?${new URLSearchParams({
      documentId,
      sessionId,
    })}`;
    const response = await fetch(url, { credentials: 'include' });
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
    };
  }, reference);
  expect(stored.status).toBe(200);
  expect(stored.type).toBe('application/pdf');
  expect(Buffer.from(stored.bytes)).toEqual(bytes);
});
