import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import path from 'node:path';

const script = buildSync({
  entryPoints: [path.resolve('utils/app/intermediateStepsDB.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'StepCache',
  platform: 'browser',
}).outputFiles[0].text;

test('native IndexedDB preserves compressed steps and repeated snapshots', async ({
  page,
}) => {
  await page.route('**/__storage-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Storage fixture</title>',
    }),
  );
  await page.goto('/__storage-fixture');
  await page.addScriptTag({ content: script });
  const result = await page.evaluate(async () => {
    const cache = (window as any).StepCache;
    const NativeCompression = window.CompressionStream;
    // Native compression with a delayed chunk models an asynchronous codec;
    // native IndexedDB may commit idle transactions before the chunk arrives.
    (window as any).CompressionStream = class {
      writable: WritableStream;
      readable: ReadableStream;
      constructor(format: CompressionFormat) {
        const stream = new NativeCompression(format);
        this.writable = stream.writable;
        this.readable = stream.readable.pipeThrough(
          new TransformStream({
            async transform(chunk, controller) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              controller.enqueue(chunk);
            },
          }),
        );
      }
    };
    const step = (UUID: string, data: string, event_timestamp = 1) => ({
      payload: { UUID, data, event_timestamp, event_type: 'TOOL_END' },
    });
    const large = step('large', 'Repeated text 🧠 '.repeat(2000));
    await cache.saveIntermediateSteps('conversation', [large]);
    await cache.saveIntermediateSteps('conversation', [large]);
    await Promise.all([
      cache.saveIntermediateSteps('conversation', [
        step('second-turn', 'new', 2),
      ]),
      cache.saveIntermediateSteps('conversation', [
        step('third-turn', 'latest', 3),
      ]),
    ]);
    const loaded = await cache.loadIntermediateSteps('conversation', 0, 10);
    return {
      count: await cache.getIntermediateStepCount('conversation'),
      ids: loaded.map((s: any) => s.payload.UUID),
      originalPreserved: loaded[0].payload.data === large.payload.data,
    };
  });
  expect(result).toEqual({
    count: 3,
    ids: ['large', 'second-turn', 'third-turn'],
    originalPreserved: true,
  });
});

test('reads and deduplicates legacy compressed chunks alongside new steps', async ({
  page,
}) => {
  await page.route('**/__storage-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Storage fixture</title>',
    }),
  );
  await page.goto('/__storage-fixture');
  await page.addScriptTag({ content: script });
  const result = await page.evaluate(async () => {
    const cache = (window as any).StepCache;
    await cache.saveIntermediateSteps('legacy', []);
    const step = {
      payload: {
        UUID: 'legacy-one',
        event_timestamp: 1,
        event_type: 'TOOL_END',
        data: 'Legacy text 🧠 '.repeat(200),
      },
    };
    const bytes = new Uint8Array(
      await new Response(
        new Blob([JSON.stringify([step])])
          .stream()
          .pipeThrough(new CompressionStream('gzip')),
      ).arrayBuffer(),
    );
    const encoded = btoa(
      Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''),
    );
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('DaedalusIntermediateStepsDB', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('intermediateSteps', 'readwrite');
      const store = transaction.objectStore('intermediateSteps');
      for (let i = 0; i < 2; i++)
        store.put({
          id: `legacy_chunk_0_${i}`,
          conversationId: 'legacy',
          chunkIndex: 0,
          steps: encoded,
          compressed: true,
          size: encoded.length,
          createdAt: i,
          updatedAt: i,
        });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    await cache.saveIntermediateSteps('legacy', [
      {
        payload: {
          UUID: 'new-two',
          event_timestamp: 2,
          event_type: 'TOOL_END',
          data: 'New turn',
        },
      },
    ]);
    const steps = await cache.loadIntermediateSteps('legacy', 0, 10);
    return {
      count: await cache.getIntermediateStepCount('legacy'),
      ids: steps.map((s: any) => s.payload.UUID),
      originalPreserved: steps[0].payload.data === step.payload.data,
    };
  });
  expect(result).toEqual({
    count: 2,
    ids: ['legacy-one', 'new-two'],
    originalPreserved: true,
  });
});
