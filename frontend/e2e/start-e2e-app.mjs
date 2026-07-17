import { ensureS3Bucket, waitForS3 } from './ensure-s3-bucket.mjs';

import Redis from 'ioredis';
import { spawn } from 'node:child_process';
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const redisUrl =
  process.env.E2E_REDIS_URL ||
  'redis://default:e2e-redis-password@127.0.0.1:16379';
const backendPort = process.env.E2E_MOCK_BACKEND_PORT || '18000';
const webPort = process.env.E2E_WEB_PORT || '15000';
const wsPort = process.env.E2E_WS_PORT || '15001';
const controlPort = Number(process.env.E2E_CONTROL_PORT || 15099);
const workerHealthFile = '/tmp/daedalus-e2e-stream-worker-health';
const workerReadyFile = '/tmp/daedalus-e2e-stream-worker-ready';
const standaloneDir = path.join(frontendDir, '.next', 'standalone');
const children = new Map();
let websocketChild = null;
let stopping = false;
let websocketStopExpected = false;

const runtimeEnv = {
  ...process.env,
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  AUTH_USERNAME: 'e2e-user',
  AUTH_PASSWORD: 'e2e-password',
  AUTH_NAME: 'E2E User',
  AUTH_LOGIN_MAX_ATTEMPTS: '20',
  SESSION_SECRET: 'e2e-session-secret-with-more-than-thirty-two-bytes',
  REDIS_URL: redisUrl,
  REDIS_TLS_ENABLED: 'false',
  BACKEND_HOST: '127.0.0.1',
  BACKEND_PORT: backendPort,
  BACKEND_API_PATH: '/v1/chat/completions',
  DAEDALUS_INTERNAL_API_TOKEN: 'e2e-internal-token',
  DOCUMENT_OBJECT_ENDPOINT: 'http://127.0.0.1:18333',
  DOCUMENT_OBJECT_ACCESS_KEY: 'e2e-s3-access',
  DOCUMENT_OBJECT_SECRET_KEY: 'e2e-s3-secret-key',
  DOCUMENT_OBJECT_BUCKET: 'daedalus-e2e-documents',
  DOCUMENT_OBJECT_REGION: 'us-east-1',
  DOCUMENT_OBJECT_PREFIX: 'daedalus-e2e',
  DOCUMENT_UPLOAD_MAX_MB: '5',
  STREAM_WORKER_CONCURRENCY: '2',
  STREAM_WORKER_LEASE_TTL_SECONDS: '10',
  STREAM_WORKER_HEARTBEAT_SECONDS: '2',
  STREAM_WORKER_CANCEL_POLL_SECONDS: '1',
  STREAM_WORKER_RECLAIM_IDLE_SECONDS: '12',
  STREAM_WORKER_RECLAIM_SCAN_SECONDS: '2',
  STREAM_WORKER_READ_BLOCK_MS: '250',
  STREAM_WORKER_DRAIN_TIMEOUT_SECONDS: '10',
  STREAM_WORKER_HEALTH_FILE: workerHealthFile,
  STREAM_WORKER_READY_FILE: workerReadyFile,
  WS_PORT: wsPort,
};

function startChild(name, args, extraEnv = {}) {
  const child = spawn(args[0], args.slice(1), {
    cwd: frontendDir,
    env: { ...runtimeEnv, ...extraEnv },
    stdio: 'inherit',
  });
  children.set(name, child);
  child.once('exit', (code, signal) => {
    children.delete(name);
    if (name === 'websocket') websocketChild = null;
    const expectedWebsocketExit = name === 'websocket' && websocketStopExpected;
    websocketStopExpected = false;
    if (!stopping && !expectedWebsocketExit) {
      console.error(
        `[e2e-harness] ${name} exited unexpectedly ` +
          `(code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      );
      void shutdown(1);
    }
  });
  return child;
}

function waitForExit(child, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopWebsocket() {
  if (!websocketChild) return;
  const child = websocketChild;
  websocketStopExpected = true;
  child.kill('SIGTERM');
  await waitForExit(child);
  if (websocketChild === child) websocketChild = null;
}

function startWebsocket() {
  if (websocketChild) return;
  websocketChild = startChild('websocket', [
    process.execPath,
    'ws-build/ws-server.js',
  ]);
}

function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if ((res.statusCode || 500) < 500) return resolve();
        setTimeout(attempt, 250);
      });
      req.once('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error(`Service did not become ready at ${url}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function waitForFile(file, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (existsSync(file)) return resolve();
      if (Date.now() >= deadline) {
        return reject(
          new Error(`Expected readiness file was not created: ${file}`),
        );
      }
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

function prepareStandaloneRuntime() {
  const serverPath = path.join(standaloneDir, 'server.js');
  if (!existsSync(serverPath)) {
    throw new Error(
      `Standalone Next.js server is missing at ${serverPath}; run npm run build first`,
    );
  }

  // Mirror the production image layout. Next.js intentionally excludes static
  // and public assets from the standalone directory, and _document loads the
  // runtime i18n config from the application root.
  mkdirSync(path.join(standaloneDir, '.next'), { recursive: true });
  cpSync(path.join(frontendDir, 'public'), path.join(standaloneDir, 'public'), {
    recursive: true,
    force: true,
  });
  cpSync(
    path.join(frontendDir, '.next', 'static'),
    path.join(standaloneDir, '.next', 'static'),
    { recursive: true, force: true },
  );
  for (const file of [
    'next.config.js',
    'next-i18next.config.js',
    'package.json',
  ]) {
    copyFileSync(path.join(frontendDir, file), path.join(standaloneDir, file));
  }
}

function controlResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const controlServer = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return controlResponse(res, 200, {
        websocket: websocketChild ? 'running' : 'stopped',
      });
    }
    if (req.method === 'POST' && req.url === '/ws/stop') {
      await stopWebsocket();
      return controlResponse(res, 200, { websocket: 'stopped' });
    }
    if (req.method === 'POST' && req.url === '/ws/start') {
      startWebsocket();
      return controlResponse(res, 200, { websocket: 'running' });
    }
    return controlResponse(res, 404, { error: 'not found' });
  } catch (error) {
    return controlResponse(res, 500, { error: String(error) });
  }
});

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  controlServer.close();
  for (const child of children.values()) child.kill('SIGTERM');
  await Promise.all([...children.values()].map((child) => waitForExit(child)));
  process.exit(exitCode);
}

async function main() {
  for (const file of [workerHealthFile, workerReadyFile]) {
    if (existsSync(file)) unlinkSync(file);
  }

  prepareStandaloneRuntime();

  await waitForS3();
  await ensureS3Bucket();

  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  await redis.connect();
  await redis.flushdb();
  await redis.quit();

  startChild('backend', [process.execPath, 'e2e/mock-backend.mjs']);
  await waitForHttp(`http://127.0.0.1:${backendPort}/health`);

  startChild('stream-worker', [
    process.execPath,
    'worker-build/stream-worker.js',
  ]);
  await waitForFile(workerReadyFile);

  startWebsocket();
  controlServer.listen(controlPort, '127.0.0.1');

  startChild('next', [process.execPath, '.next/standalone/server.js'], {
    HOSTNAME: '127.0.0.1',
    PORT: webPort,
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void shutdown(0));
}

main().catch((error) => {
  console.error('[e2e-harness] startup failed', error);
  void shutdown(1);
});
