// Real runtime image -> selected, built gateway -> deterministic Responses peer.
// All endpoints, configuration and credentials belong to this disposable run.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const image = process.env.E2E_RESPONSES_IMAGE;
const gateway = process.env.E2E_RESPONSES_GATEWAY_BINARY;
const routes = process.env.E2E_RESPONSES_ROUTES;
if (!image || !gateway || !routes)
  throw new Error(
    'Responses tests require an image, gateway binary and explicit routes file',
  );
const cases = JSON.parse(
  readFileSync(
    '../builder/runtime/tests/fixtures/responses-accumulation.json',
    'utf8',
  ),
);
const directory = mkdtempSync(path.join(tmpdir(), 'daedalus-responses-e2e-'));
chmodSync(directory, 0o755);
const container = `daedalus-responses-e2e-${process.pid}`;
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  for (const child of children) child.kill('SIGTERM');
  peer.close();
  rmSync(directory, { recursive: true, force: true });
  process.exit(code);
}
function launch(command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  children.push(child);
  child.on('error', () => stop(1));
  child.on('exit', () => {
    if (!stopping) stop(1);
  });
  return child;
}
const peer = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({ data: [{ id: 'fixture', context_length: 32768 }] }),
    );
    return;
  }
  const body = JSON.parse(raw || '{}');
  if (req.url === '/v1/systemone') {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        model: 'fixture',
        usage: { input_tokens: 1, output_tokens: 0 },
        answers: {
          effort: {
            type: 'choice',
            choice: 'low',
            confidence: 1,
            probabilities: {
              instant: 0,
              low: 1,
              high: 0,
              max: 0,
              uncertain: 0,
            },
          },
        },
      }),
    );
    return;
  }
  const input = body.input ?? [];
  const user = input.filter((item) => item.role === 'user').at(-1);
  const marker = JSON.stringify(user ?? '').match(
    /RESPONSES_CASE:([a-z_]+)/,
  )?.[1];
  const fixture = cases.find((item) => item.name === marker);
  if (!fixture) {
    res.writeHead(400);
    res.end('Missing synthetic case');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  // Let the new conversation establish its subscription before transient
  // assertions; missed-delivery repair is exercised separately by hook tests.
  if (['correction', 'empty_correction'].includes(marker))
    await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const [sequence, original] of fixture.events.entries()) {
    const event = { ...original, sequence_number: sequence };
    const bytes = Buffer.from(
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
    // Byte fragmentation tests incremental UTF-8 decoding through both services.
    for (let offset = 0; offset < bytes.length; offset += 13)
      res.write(bytes.subarray(offset, offset + 13));
    const pause =
      ['correction', 'empty_correction'].includes(marker) &&
      ['response.output_text.delta', 'response.output_text.done'].includes(
        event.type,
      )
        ? 1500
        : 90;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  res.end();
});
await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
const provider = `http://127.0.0.1:${peer.address().port}/v1`;
// The dedicated suite explicitly uses the selected OpenAI Responses route.
let source = readFileSync(routes, 'utf8');
if (/^include\s*=/m.test(source)) {
  const composed = path.join(directory, 'composed.toml');
  const result = spawnSync('python3', [
    path.join(path.dirname(routes), 'scripts/render_routes.py'),
    routes,
    composed,
    '--compose-only',
  ]);
  if (result.status !== 0)
    throw new Error('Could not compose the selected Switchyard routes');
  source = readFileSync(composed, 'utf8');
}
if (!source.includes('format = "openai_responses"'))
  throw new Error('Select native Responses routes for this suite');
writeFileSync(
  path.join(directory, 'routes.toml'),
  source
    .replace(/base_url = "[^"]+"/g, `base_url = "${provider}"`)
    .replace('max_input_tokens = "auto"', 'max_input_tokens = 16384')
    .replace('truncate_input = true', 'truncate_input = false'),
);
const reservation = http.createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const gatewayPort = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
launch(
  gateway,
  [
    '--config',
    path.join(directory, 'routes.toml'),
    '--host',
    '127.0.0.1',
    '--port',
    String(gatewayPort),
  ],
  { OPENAI_API_KEY: 'synthetic' },
);
writeFileSync(
  path.join(directory, 'agent.json'),
  JSON.stringify({
    llms: {
      main: {
        base_url: `http://127.0.0.1:${gatewayPort}/v1`,
        model_name: 'daedalus',
        api_type: 'responses',
        api_key: 'synthetic',
        max_retries: 0,
      },
    },
    workflow: {
      _type: 'daedalus_rust_agent',
      llm_name: 'main',
      tools: [],
      instructions: 'Return the synthetic fixture answer.',
    },
  }),
);
launch('docker', [
  'run',
  '--rm',
  '--name',
  container,
  '--network',
  'host',
  '--mount',
  `type=bind,source=${directory},target=/fixture,readonly`,
  '--entrypoint',
  '/workspace/daedalus-runtime',
  '-e',
  'DAEDALUS_CONFIG_FILE=/fixture/agent.json',
  '-e',
  'DAEDALUS_HOST=127.0.0.1',
  '-e',
  `DAEDALUS_PORT=${process.env.E2E_MOCK_BACKEND_PORT || 18000}`,
  '-e',
  'DAEDALUS_INTERNAL_API_TOKEN=e2e-internal-token',
  '-e',
  'DAEDALUS_PREPARATION=rust',
  '-e',
  'DAEDALUS_AUTHORIZATION=rust',
  '-e',
  'DAEDALUS_MEMORY_MODE=disabled',
  '-e',
  'DAEDALUS_TOOL_EXECUTOR=disabled',
  image,
]);
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
