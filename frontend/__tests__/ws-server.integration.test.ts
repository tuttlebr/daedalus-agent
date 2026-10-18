// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'WebSocket connect state with real Redis',
  () => {
    let client: any;
    let ws: typeof import('../ws-server');
    const user = `ws-streaming-${process.pid}-${Date.now()}`;
    const other = `${user}-other`;
    const keys: string[] = [];
    const streamingKey = (owner: string, conversationId: string) => {
      const key = `streaming:user:${owner}:conversation:${conversationId}`;
      keys.push(key);
      return key;
    };
    const state = (owner: string, conversationId: string) => ({
      conversationId,
      sessionId: `job-${conversationId}`,
      startedAt: 1_700_000_000_000,
      userId: owner,
    });

    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('A disposable REDIS_URL is required');
      ws = await import('../ws-server');
      client = (await import('@/server/session/redis')).getRedis();
      await client.ping();
    });

    afterAll(async () => {
      if (client) {
        if (keys.length) await client.del(...keys);
        client.disconnect();
      }
    });

    it('reports only the user conversations that are streaming, in either storage format', async () => {
      const conversations = `user:${user}:conversations`;
      keys.push(conversations, `user:${other}:conversations`);
      await client.sadd(conversations, 'json', 'plain', 'idle', 'broken');
      await client.call(
        'JSON.SET',
        streamingKey(user, 'json'),
        '$',
        JSON.stringify(state(user, 'json')),
      );
      await client.set(
        streamingKey(user, 'plain'),
        JSON.stringify(state(user, 'plain')),
      );
      await client.set(streamingKey(user, 'broken'), 'not-json');
      // Deleted conversations and other users' state are not reported.
      await client.set(
        streamingKey(user, 'deleted'),
        JSON.stringify(state(user, 'deleted')),
      );
      await client.sadd(`user:${other}:conversations`, 'json');
      await client.set(
        streamingKey(other, 'json'),
        JSON.stringify(state(other, 'json')),
      );

      expect(await ws.readStreamingStates(client, user)).toEqual({
        json: state(user, 'json'),
        plain: state(user, 'plain'),
      });
      expect(await ws.readStreamingStates(client, `${user}-none`)).toEqual({});
    });

    it('reads conversation sets larger than one script batch', async () => {
      const owner = `${user}-many`;
      const conversations = `user:${owner}:conversations`;
      keys.push(conversations);
      const ids = Array.from({ length: 1203 }, (_, index) => `c-${index}`);
      await client.sadd(conversations, ...ids);
      for (const id of ['c-0', 'c-600', 'c-1202']) {
        await client.set(
          streamingKey(owner, id),
          JSON.stringify(state(owner, id)),
        );
      }

      expect(
        Object.keys(await ws.readStreamingStates(client, owner)).sort(),
      ).toEqual(['c-0', 'c-1202', 'c-600']);
    });
  },
);
