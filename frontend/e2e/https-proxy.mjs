import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// The runner owns one ephemeral certificate for the proxy and browser trust.
export function createTestCertificate() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'daedalus-e2e-tls-'));
  const key = path.join(directory, 'key.pem');
  const cert = path.join(directory, 'cert.pem');
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    const publicKey = new X509Certificate(readFileSync(cert)).publicKey.export({
      type: 'spki',
      format: 'der',
    });
    return {
      key,
      cert,
      spki: createHash('sha256').update(publicKey).digest('base64'),
      close: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

// Real production sessions require Secure cookies. Terminate test-only TLS on
// loopback for both HTTP and actual WebSocket upgrades, without changing auth.
export async function startHttpsProxy({ port, nextPort, wsPort, key, cert }) {
  if (!key || !cert)
    throw new Error(
      'Run npm run e2e to create the disposable HTTPS certificate before Playwright starts',
    );
  const sockets = new Set();
  let server;
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  try {
    server = https.createServer(
      { key: readFileSync(key), cert: readFileSync(cert) },
      (req, res) => {
        const upstream = http.request(
          {
            hostname: '127.0.0.1',
            port: nextPort,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, 'x-forwarded-proto': 'https' },
          },
          (response) => {
            res.writeHead(response.statusCode, response.headers);
            response.on('error', () => res.destroy());
            response.pipe(res);
          },
        );
        upstream.on('error', () => {
          if (res.headersSent) res.destroy();
          else {
            res.writeHead(502);
            res.end();
          }
        });
        res.once('close', () => upstream.destroy());
        req.pipe(upstream);
      },
    );
    server.on('connection', track);
    server.on('upgrade', (req, socket, head) => {
      const upstream = track(
        net.connect({ host: '127.0.0.1', port: Number(wsPort) }),
      );
      upstream.once('connect', () => {
        const headers = req.rawHeaders.reduce((lines, value, index) => {
          if (index % 2 === 0)
            lines.push(`${value}: ${req.rawHeaders[index + 1]}`);
          return lines;
        }, []);
        upstream.write(
          `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join(
            '\r\n',
          )}\r\n\r\n`,
        );
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.once('close', () => upstream.destroy());
      upstream.once('close', () => socket.destroy());
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(port), '127.0.0.1', resolve);
    });
  } catch (error) {
    server?.close();
    for (const socket of sockets) socket.destroy();
    throw error;
  }
  return () => {
    server.close();
    for (const socket of sockets) socket.destroy();
  };
}
