const { spawn } = require('node:child_process');

const children = new Set();
let shuttingDown = false;

function start(name, args) {
  const child = spawn(args[0], args.slice(1), {
    stdio: 'inherit',
  });

  children.add(child);
  child.on('error', (error) => {
    children.delete(child);
    if (shuttingDown) return;

    console.error(`[runtime] failed to start ${name}:`, error);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;

    const exitCode = typeof code === 'number' ? code : 1;
    console.error(
      `[runtime] ${name} exited unexpectedly` +
        ` (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
    );
    shutdown(exitCode);
  });

  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  setTimeout(() => {
    process.exit(code);
  }, 5_000).unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

start('websocket', ['node', 'ws-server.js']);
start('next', ['node', 'server.js']);
