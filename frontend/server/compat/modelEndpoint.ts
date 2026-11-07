import type { NextApiRequest, NextApiResponse } from 'next';

import { buildBackendUrl, getBackendHost } from '@/utils/app/backendApi';
import { withInternalBackendAuth } from '@/utils/server/backendAuth';

import { COMPAT_DIRECT_MODEL_ALIAS, isCompatModelEnabled } from './config';
import { CompatError, invalidRequest } from './errors';
import { isPlainObject } from './request';
import { openAIErrorBody } from './responders';

/** Forward raw model input/output; never normalize away tool history or JSON. */
export async function handleModelRequest(
  req: NextApiRequest,
  res: NextApiResponse,
  body: unknown,
  username: string,
  route: 'chat.completions' | 'responses' | 'messages',
): Promise<boolean> {
  if (!isPlainObject(body) || body.model !== COMPAT_DIRECT_MODEL_ALIAS)
    return false;
  if (!isCompatModelEnabled())
    throw new CompatError(
      'not_found',
      'The direct model endpoint is disabled.',
    );
  if (route === 'messages')
    throw invalidRequest(
      'daedalus-model supports the OpenAI APIs only.',
      'model',
    );
  for (const header of ['x-daedalus-conversation-id', 'idempotency-key']) {
    if (req.headers[header] !== undefined)
      throw invalidRequest(
        `The direct model endpoint does not support ${header}.`,
        header,
      );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 610_000);
  timeout.unref?.();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const upstream = await fetch(
      buildBackendUrl({
        backendHost: getBackendHost(),
        pathOverride: `/internal/model/${
          route === 'responses' ? 'responses' : 'chat/completions'
        }`,
      }),
      {
        method: 'POST',
        headers: withInternalBackendAuth({
          'Content-Type': 'application/json',
          'x-user-id': username,
        }),
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      },
    );
    if (!upstream.ok) {
      // These are sanitized runtime errors, not raw provider diagnostics.
      const failure = await upstream.json().catch(() => null);
      res.setHeader('x-should-retry', 'false');
      const failureBody = openAIErrorBody(
        new CompatError(
          upstream.status === 429
            ? 'rate_limit'
            : upstream.status < 500
            ? 'invalid_request'
            : 'api_error',
          typeof failure?.error?.message === 'string'
            ? failure.error.message
            : 'Model endpoint request failed.',
        ),
      );
      res.status(upstream.status).json(failureBody.body);
      return true;
    }
    if (!upstream.body) throw new Error('Missing model response body');
    res.status(upstream.status);
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') || 'application/json',
    );
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    reader = upstream.body.getReader();
    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            res.off('drain', onDrain);
            controller.signal.removeEventListener('abort', onAbort);
          };
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onAbort = () => {
            cleanup();
            reject(new Error('Disconnected'));
          };
          res.once('drain', onDrain);
          controller.signal.addEventListener('abort', onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        });
      }
    }
    if (!res.destroyed) res.end();
    return true;
  } catch {
    if (res.destroyed) return true;
    if (res.headersSent) {
      // A broken stream must not acquire a fabricated successful terminal event.
      res.destroy();
      return true;
    }
    throw new CompatError('api_error', 'Model endpoint request failed.', {
      code: 'model_endpoint_failed',
    });
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    clearTimeout(timeout);
    res.off('close', onClose);
  }
}
