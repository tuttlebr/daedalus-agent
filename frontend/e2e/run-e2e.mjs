import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const composeFile = path.join(frontendDir, 'e2e', 'docker-compose.yml');
const publicBuildEnv = {
  ...process.env,
  NEXT_PUBLIC_WEBSOCKET_URL: 'ws://127.0.0.1:15001',
  NEXT_PUBLIC_WS_FALLBACK_POLL_INTERVAL_MS: '1000',
  NEXT_TELEMETRY_DISABLED: '1',
  SESSION_SECRET: 'e2e-session-secret-with-more-than-thirty-two-bytes',
};

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: frontendDir,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  }
}

let servicesStarted = false;
try {
  servicesStarted = true;
  run('docker', [
    'compose',
    '-f',
    composeFile,
    'up',
    '-d',
    '--build',
    '--wait',
    '--wait-timeout',
    '120',
  ]);
  if (process.env.E2E_SKIP_BUILD !== '1') {
    rmSync(path.join(frontendDir, '.next'), { recursive: true, force: true });
    run('npm', ['run', 'build'], publicBuildEnv);
    run('npm', ['run', 'build:websocket'], publicBuildEnv);
    run('npm', ['run', 'build:stream-worker'], publicBuildEnv);
  }

  run(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['playwright', 'test', ...process.argv.slice(2)],
    publicBuildEnv,
  );
} finally {
  if (servicesStarted && process.env.E2E_KEEP_SERVICES !== '1') {
    spawnSync(
      'docker',
      ['compose', '-f', composeFile, 'down', '--volumes', '--remove-orphans'],
      { cwd: frontendDir, stdio: 'inherit' },
    );
  }
}
