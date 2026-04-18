import { NextApiRequest, NextApiResponse } from 'next';
import http from 'http';
import { getOrSetSessionId, getUserId } from '../session/_utils';
import { buildBackendUrl, getBackendHost } from '@/utils/app/backendApi';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '5mb',
    },
    responseLimit: false,
    externalResolver: true,
  },
  maxDuration: 300,
};

const GENERATE_TIMEOUT_MS = 180_000;

function postJson(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || '80',
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 500,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Backend request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sessionId = getOrSetSessionId(req, res);
    const userId = await getUserId(req, res);

    const backendUrl = buildBackendUrl({
      backendHost: getBackendHost(),
      pathOverride: '/v1/images/generate',
    });

    const payload = {
      ...req.body,
      sessionId: req.body?.sessionId ?? sessionId,
      user: req.body?.user ?? userId,
    };

    const backendResponse = await postJson(
      backendUrl,
      JSON.stringify(payload),
      {
        'Content-Type': 'application/json',
        'x-user-id': userId,
      },
      GENERATE_TIMEOUT_MS,
    );

    res.status(backendResponse.statusCode);
    try {
      return res.json(JSON.parse(backendResponse.body));
    } catch {
      return res.send(backendResponse.body);
    }
  } catch (error) {
    console.error('images/generate proxy error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const isTimeout = message.includes('timed out') || message.includes('ETIMEDOUT');
    const isConnRefused = message.includes('ECONNREFUSED');
    if (isTimeout) {
      return res.status(504).json({ error: 'Backend timed out', message });
    }
    if (isConnRefused) {
      return res.status(502).json({ error: 'Backend unavailable', message });
    }
    return res.status(500).json({ error: 'Internal server error', message });
  }
}
