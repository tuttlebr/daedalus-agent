// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.disconnect();
  }

  disconnect(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000, Buffer.from(''));
  }

  messages(): any[] {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

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

    it.each([
      ['an owned member conversation', 'owned', true],
      ['a legacy member conversation without an owner', 'legacy', true],
      ['a member conversation owned by another user', 'foreign', false],
      ['a live stream the user started', 'live', true],
      ['a live-stream record naming another user', 'foreign-live', false],
      ['an unknown conversation', 'unknown', false],
    ] as const)(
      'authorizes chat tokens for %s from stored ownership',
      async (_label, kind, allowed) => {
        // The default dependencies read the same Redis as production.
        const owner = `${user}-chat-${kind}`;
        const id = (name: string) => `${owner}-${name}`;
        const conversationId = id(kind);
        const conversations = `user:${owner}:conversations`;
        keys.push(conversations);
        await client.sadd(
          conversations,
          id('owned'),
          id('legacy'),
          id('foreign'),
        );
        for (const [name, ownerId] of [
          ['owned', owner],
          ['legacy', undefined],
          ['foreign', other],
        ] as const) {
          keys.push(`conversation:${id(name)}`);
          await client.set(
            `conversation:${id(name)}`,
            JSON.stringify({ id: id(name), ownerId }),
          );
        }
        await client.set(
          streamingKey(owner, id('live')),
          JSON.stringify(state(owner, id('live'))),
        );
        await client.set(
          streamingKey(owner, id('foreign-live')),
          JSON.stringify(state(other, id('foreign-live'))),
        );

        const socket = new FakeSocket();
        await ws.initializeAuthenticatedConnection(
          socket as any,
          owner,
          `sid-${owner}`,
        );
        try {
          expect(socket.messages()[0]).toMatchObject({ type: 'connected' });
          socket.emit(
            'message',
            Buffer.from(
              JSON.stringify({ type: 'subscribe_chat', conversationId }),
            ),
          );
          const token = { type: 'token', conversationId, content: 'secret' };
          if (allowed) {
            // Publish until the real subscription delivers the token.
            await vi.waitFor(async () => {
              await client.publish(
                `user:${owner}:chat:${conversationId}:tokens`,
                JSON.stringify(token),
              );
              expect(socket.messages()).toContainEqual(token);
            });
          } else {
            await vi.waitFor(() =>
              expect(socket.messages()).toContainEqual({
                type: 'error',
                message: 'Unauthorized chat subscription',
              }),
            );
          }
        } finally {
          socket.disconnect();
        }
      },
    );

    it.each(['json', 'plain'])(
      'authorizes a %s job subscription from the request owner field alone',
      async (format) => {
        const owner = `${user}-job-${format}`;
        const jobId = `${owner}-job`;
        const requestKey = `async-job-request:${jobId}`;
        keys.push(requestKey);
        const request = JSON.stringify({
          jobId,
          executionMode: 'stream',
          natBaseUrl: 'http://backend:8000',
          messages: Array.from({ length: 100 }, () => ({
            role: 'user',
            content: 'history '.repeat(100),
          })),
          userId: owner,
        });
        if (format === 'json')
          await client.call('JSON.SET', requestKey, '$', request);
        else await client.set(requestKey, request);
        for (const [subscriber, allowed] of [
          [owner, true],
          [other, false],
        ] as const) {
          const socket = new FakeSocket();
          await ws.initializeAuthenticatedConnection(
            socket as any,
            subscriber,
            `sid-${subscriber}-${format}`,
          );
          try {
            socket.emit(
              'message',
              Buffer.from(JSON.stringify({ type: 'subscribe_job', jobId })),
            );
            const status = { jobId, status: 'streaming' };
            if (allowed) {
              await vi.waitFor(async () => {
                await client.publish(
                  `job:${jobId}:status`,
                  JSON.stringify(status),
                );
                expect(socket.messages()).toContainEqual({
                  type: 'job_status',
                  data: status,
                });
              });
            } else {
              await vi.waitFor(() =>
                expect(socket.messages()).toContainEqual({
                  type: 'error',
                  message: 'Unauthorized job subscription',
                }),
              );
            }
          } finally {
            socket.disconnect();
          }
        }
      },
    );

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
