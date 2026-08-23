import type { NextApiRequest, NextApiResponse } from 'next';

import {
  buildBackendBaseUrlForMode,
  buildBackendUrlFromBase,
} from '@/utils/app/backendApi';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout';
import { resolveTimezoneFromHeaders } from '@/utils/server/backendAuth';

import { buildNatRequestHeaders } from '@/server/chat/natMessages';
import { requireAuthenticatedUser } from '@/server/session/_utils';

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MEMORY_API_TIMEOUT_MS = 30_000;

export type MemoryRoute = { methods: string[]; backendPath: string };

export function resolveMemoryRoute(path: string[]): MemoryRoute | null {
  if (path.length === 1 && path[0] === 'memories') {
    return { methods: ['GET'], backendPath: '/v1/memories' };
  }
  if (path.length === 2 && path[0] === 'memories' && path[1] === 'clear') {
    return { methods: ['POST'], backendPath: '/v1/memories/clear' };
  }
  if (
    path.length === 2 &&
    path[0] === 'memories' &&
    RESOURCE_ID.test(path[1])
  ) {
    return {
      methods: ['PATCH'],
      backendPath: `/v1/memories/${encodeURIComponent(path[1])}`,
    };
  }
  if (
    path.length === 3 &&
    path[0] === 'memories' &&
    RESOURCE_ID.test(path[1]) &&
    path[2] === 'invalidate'
  ) {
    return {
      methods: ['POST'],
      backendPath: `/v1/memories/${encodeURIComponent(path[1])}/invalidate`,
    };
  }
  if (path.length === 1 && path[0] === 'sources') {
    return { methods: ['GET'], backendPath: '/v1/memory-sources' };
  }
  if (path.length === 2 && path[0] === 'sources' && RESOURCE_ID.test(path[1])) {
    return {
      methods: ['GET', 'DELETE'],
      backendPath: `/v1/memory-sources/${encodeURIComponent(path[1])}`,
    };
  }
  if (path.length === 1 && path[0] === 'pages') {
    return { methods: ['GET'], backendPath: '/v1/memory-pages' };
  }
  if (path.length === 2 && path[0] === 'pages' && RESOURCE_ID.test(path[1])) {
    return {
      methods: ['GET'],
      backendPath: `/v1/memory-pages/${encodeURIComponent(path[1])}`,
    };
  }
  return null;
}

function responsePayload(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'Memory backend returned an invalid response.' };
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  const path = Array.isArray(req.query.path) ? req.query.path : [];
  const route = resolveMemoryRoute(path);
  if (!route) return res.status(404).json({ error: 'Memory route not found.' });
  if (!req.method || !route.methods.includes(req.method)) {
    res.setHeader('Allow', route.methods);
    return res.status(405).end('Method Not Allowed');
  }

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'path') continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string') query.append(key, item);
    }
  }
  const suffix = query.size ? `?${query.toString()}` : '';
  const url = `${buildBackendUrlFromBase(
    buildBackendBaseUrlForMode(),
    route.backendPath,
  )}${suffix}`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: req.method,
        headers: buildNatRequestHeaders(
          session.username,
          req.method === 'GET'
            ? { Accept: 'application/json' }
            : {
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
          undefined,
          resolveTimezoneFromHeaders(req.headers),
        ),
        ...(req.method !== 'GET'
          ? { body: JSON.stringify(req.body || {}) }
          : {}),
      },
      MEMORY_API_TIMEOUT_MS,
    );
    return res
      .status(response.status)
      .json(responsePayload(await response.text()));
  } catch {
    return res.status(502).json({ error: 'Memory service is unavailable.' });
  }
}
