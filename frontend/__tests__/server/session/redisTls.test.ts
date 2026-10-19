// @vitest-environment node
import {
  resolveRedisUrl,
  REDIS_CLIENT_OPTIONS,
} from '@/server/session/redisShared';
import Redis from 'ioredis';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/session/dns-cache', () => ({
  getCachedIp: () => '127.0.0.1',
}));

describe('Redis DNS caching with TLS', () => {
  let directory: string;
  let server: Server;
  let certificate: Buffer;
  let port: number;
  const sockets = new Set<TLSSocket>();

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'daedalus-redis-tls-'));
    const cert = join(directory, 'cert.pem');
    const key = join(directory, 'key.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    certificate = readFileSync(cert);
    server = createServer(
      { key: readFileSync(key), cert: certificate },
      (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('data', () => socket.write('+PONG\r\n'));
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('still uses cached addresses for plaintext Redis', () => {
    expect(resolveRedisUrl('redis://localhost:6379/2')).toBe(
      'redis://127.0.0.1:6379/2',
    );
  });

  it.each(['localhost', '127.0.0.1'])(
    'checks the configured hostname against the certificate (%s)',
    async (host) => {
      const client = new Redis(resolveRedisUrl(`rediss://${host}:${port}`), {
        ...REDIS_CLIENT_OPTIONS,
        tls: { ca: certificate },
        enableReadyCheck: false,
        disableClientInfo: true,
        retryStrategy: () => null,
      });
      const errors: Error[] = [];
      client.on('error', (error) => errors.push(error));
      try {
        if (host === 'localhost') {
          await client.connect();
          expect(await client.ping()).toBe('PONG');
        } else {
          await expect(client.connect()).rejects.toThrow();
          expect(errors).toEqual([
            expect.objectContaining({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
          ]);
        }
      } finally {
        client.disconnect();
      }
    },
  );
});
