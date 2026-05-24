import type { NextApiRequest, NextApiResponse } from 'next';
import { getRedis } from '@/server/session/redis';

const READY_TIMEOUT_MS = Number(process.env.FRONTEND_READY_TIMEOUT_MS || 1_000);
const WS_PORT = process.env.WS_PORT || '3001';

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function checkRedis(): Promise<void> {
  const redis = getRedis();
  await withTimeout(redis.ping(), READY_TIMEOUT_MS, 'Redis ping');
}

async function checkWebSocketSidecar(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READY_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${WS_PORT}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`WebSocket health returned ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ready = req.query.ready === '1' || req.query.ready === 'true';
  if (!ready) {
    return res.status(200).json({ status: 'ok' });
  }

  const checks = await Promise.allSettled([
    checkRedis(),
    checkWebSocketSidecar(),
  ]);
  const [redis, websocket] = checks;
  const ok = checks.every((check) => check.status === 'fulfilled');

  return res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'unready',
    checks: {
      redis: redis.status,
      websocket: websocket.status,
    },
  });
}
