// @vitest-environment node
import { imageContext } from '../../fixtures/imageContext';

import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const identity = vi.hoisted(() => ({ username: '' }));
vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: async () => identity,
  getOrSetSessionId: () => 'history-review-session',
}));

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'image history persistence with real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let client: ReturnType<typeof redis.getRedis>;
    let handler: typeof import('@/pages/api/images/history').default;
    let historyKey: string;
    const imageId = randomUUID();
    const imageKey = `generated:image:${imageId}`;
    const entry = (id: string) => ({
      id,
      mode: 'generate',
      prompt: imageContext.prompt,
      params: {},
      inputImages: [],
      maskImage: null,
      outputImageIds: [imageId],
      model: 'fixture',
      createdAt: 1,
      imageContext,
    });
    const request = async (method: string, body = {}, query = {}) => {
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
      };
      await handler({ method, body, query } as any, res as any);
      expect(res.status).toHaveBeenCalledWith(200);
      return res.json.mock.calls[0][0];
    };
    beforeAll(async () => {
      if (!process.env.REDIS_URL) throw new Error('Disposable Redis required');
      redis = await import('@/server/session/redis');
      client = redis.getRedis();
      identity.username = `history-review-${randomUUID()}`;
      historyKey = redis.sessionKey([
        'user',
        identity.username,
        'imagePanelHistory',
      ]);
      handler = (await import('@/pages/api/images/history')).default;
    });
    beforeEach(async () => {
      await client.del(historyKey, imageKey);
      await client.call(
        'JSON.SET',
        imageKey,
        '$',
        JSON.stringify({ data: 'aW1n', userId: identity.username }),
      );
    });
    afterAll(async () => {
      if (client) {
        await client.del(historyKey, imageKey);
        client.disconnect();
      }
    });

    it('keeps every concurrent history save', async () => {
      const entries = Array.from({ length: 20 }, (_, index) =>
        entry(`entry-${index}`),
      );
      await Promise.all(
        entries.map((value) => request('POST', { entry: value })),
      );
      const saved = await redis.jsonGet(historyKey);
      expect(saved.map((value: any) => value.id).sort()).toEqual(
        entries.map((value) => value.id).sort(),
      );
    });

    it('retains image guidance and exact prompt through a reload', async () => {
      await request('POST', { entry: entry('guided') });
      expect((await request('GET')).history[0].imageContext).toEqual(
        imageContext,
      );
    });

    it.each(['plain', 'RedisJSON'])(
      'updates %s history and deletes an unreferenced asset atomically',
      async (format) => {
        const stored = JSON.stringify([entry('old')]);
        if (format === 'plain') await client.set(historyKey, stored);
        else await client.call('JSON.SET', historyKey, '$', stored);
        const { appendImageHistoryEntry } = await import(
          '@/server/images/historyStore'
        );
        // The completed-job writer and the API must preserve one another's saves.
        await Promise.all([
          appendImageHistoryEntry(historyKey, entry('job')),
          request('POST', { entry: entry('api') }),
        ]);
        expect(
          (await request('GET')).history.map((value: any) => value.id).sort(),
        ).toEqual(['api', 'job', 'old']);
        await request('DELETE', {}, { all: '1', deleteAssets: '1' });
        expect(await redis.jsonGet(historyKey)).toEqual([]);
        expect(await client.ttl(historyKey)).toBeGreaterThan(0);
        expect(await client.exists(imageKey)).toBe(0);
      },
    );

    it('keeps legacy entries readable without exposing malformed guidance', async () => {
      await client.set(
        historyKey,
        JSON.stringify([
          { ...entry('legacy'), imageContext: undefined },
          {
            ...entry('invalid'),
            imageContext: {
              ...imageContext,
              brief: { ...imageContext.brief, preserve: 'invalid' },
            },
          },
        ]),
      );
      const { history } = await request('GET');
      expect(history.map((value: any) => value.id)).toEqual([
        'legacy',
        'invalid',
      ]);
      expect(
        history.every((value: any) => value.imageContext === undefined),
      ).toBe(true);
    });

    it('preserves a concurrent save and its asset when another entry is removed', async () => {
      await request('POST', { entry: entry('old') });
      let entered!: () => void;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const call = client.call.bind(client);
      let first = true;
      const spy = vi.spyOn(client, 'call').mockImplementation((async (
        ...args: any[]
      ) => {
        if (first && args[0] === 'JSON.GET' && args[1] === imageKey) {
          first = false;
          entered();
          await resume;
        }
        return call(...(args as [string, ...any[]]));
      }) as typeof client.call);
      const deletion = request('DELETE', {}, { id: 'old', deleteAssets: '1' });
      try {
        await blocked;
        await request('POST', { entry: entry('new') });
      } finally {
        release();
        await deletion;
        spy.mockRestore();
      }
      expect(
        (await request('GET')).history.map((value: any) => value.id),
      ).toEqual(['new']);
      expect(await client.exists(imageKey)).toBe(1);
    });
  },
);
