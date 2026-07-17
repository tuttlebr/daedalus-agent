import http from 'node:http';

const port = Number(process.env.E2E_MOCK_BACKEND_PORT || 18000);
const internalToken =
  process.env.DAEDALUS_INTERNAL_API_TOKEN || 'e2e-internal-token';
const trustedUser = process.env.AUTH_USERNAME || 'e2e-user';

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function hasTrustedContext(req, res) {
  if (
    req.headers['x-daedalus-internal-token'] !== internalToken ||
    req.headers['x-user-id'] !== trustedUser
  ) {
    json(res, 401, { error: 'trusted request context required' });
    return false;
  }
  return true;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function lastPrompt(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === 'user' &&
      typeof message.content === 'string' &&
      !message.content.startsWith('[IDENTITY]') &&
      !message.content.startsWith('[SOURCE_POLICY]')
    ) {
      return message.content;
    }
  }
  return '';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendToken(res, content) {
  res.write(
    `data: ${JSON.stringify({
      choices: [{ delta: { content } }],
    })}\n\n`,
  );
}

async function streamChat(req, res) {
  const body = await readJson(req);
  const prompt = lastPrompt(body);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.flushHeaders();

  if (prompt.includes('E2E_CANCEL')) {
    sendToken(res, 'E2E cancellation pending');
    const keepAlive = setInterval(() => res.write(': waiting\n\n'), 5_000);
    res.once('close', () => clearInterval(keepAlive));
    return;
  }

  if (prompt.includes('E2E_DISCONNECT')) {
    sendToken(res, 'E2E before disconnect');
    await wait(2_500);
    if (res.destroyed) return;
    sendToken(res, ' recovered by polling');
    res.end('data: [DONE]\n\n');
    return;
  }

  if (prompt.includes('E2E_UNAVAILABLE')) {
    await wait(300);
    sendToken(res, 'E2E polling fallback reply');
    res.end('data: [DONE]\n\n');
    return;
  }

  const tokens = ['E2E ', 'streamed ', 'reply'];
  for (const token of tokens) {
    await wait(300);
    if (res.destroyed) return;
    sendToken(res, token);
  }
  res.end('data: [DONE]\n\n');
}

async function streamDocumentIngest(req, res) {
  const body = await readJson(req);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(
    `event: progress\ndata: ${JSON.stringify({
      completed: 0,
      total: Array.isArray(body.documentRefs) ? body.documentRefs.length : 1,
      current: 'e2e-document.txt',
      currentIndex: 1,
      percent: 50,
      phase: 'indexing',
      message: 'Indexing deterministic document',
    })}\n\n`,
  );
  await wait(200);
  res.end(
    `event: complete\ndata: ${JSON.stringify({
      output: `E2E ingestion completed for ${
        body.collection_name || 'unknown'
      }`,
    })}\n\n`,
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    return json(res, 200, { status: 'ok' });
  }

  if (url.pathname === '/docs' && req.method === 'HEAD') {
    if (!hasTrustedContext(req, res)) return;
    res.writeHead(200);
    return res.end();
  }

  if (url.pathname === '/v1/metadata/collections' && req.method === 'GET') {
    if (!hasTrustedContext(req, res)) return;
    return json(res, 200, {
      databaseName: 'daedalus_e2e',
      userCollection: {
        name: 'e2e_user_private',
        displayName: 'E2E private knowledge base',
        scope: 'user',
        exists: true,
        readable: true,
        writable: true,
      },
      sharedCollections: [],
      writableCollections: [
        {
          name: 'e2e_user_private',
          displayName: 'E2E private knowledge base',
          scope: 'user',
          exists: true,
          readable: true,
          writable: true,
        },
      ],
    });
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    if (!hasTrustedContext(req, res)) return;
    try {
      return await streamChat(req, res);
    } catch (error) {
      if (!res.headersSent) return json(res, 500, { error: String(error) });
      return res.destroy(error instanceof Error ? error : undefined);
    }
  }

  if (url.pathname === '/v1/documents/ingest/stream' && req.method === 'POST') {
    if (!hasTrustedContext(req, res)) return;
    try {
      return await streamDocumentIngest(req, res);
    } catch (error) {
      if (!res.headersSent) return json(res, 500, { error: String(error) });
      return res.destroy(error instanceof Error ? error : undefined);
    }
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[e2e-backend] listening on http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
