import http from 'node:http';
import https from 'node:https';

// Readiness must time out for unhealthy responses and silent sockets as well
// as connection refusals. A single deadline bounds all retries.
export async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  const client = new URL(url).protocol === 'https:' ? https : http;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const ready = await new Promise((resolve) => {
      const request = client.get(url);
      const timeout = setTimeout(() => request.destroy(), remaining);
      const finish = (value) => {
        clearTimeout(timeout);
        resolve(value);
      };
      request.once('response', (response) => {
        // A health probe only needs the status, not an unbounded body.
        response.destroy();
        finish((response.statusCode || 500) < 500);
      });
      request.once('error', () => finish(false));
      request.once('close', () => finish(false));
    });
    if (ready) return;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))),
    );
  }
  throw new Error(`Service did not become ready at ${url}`);
}
