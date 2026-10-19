// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('frontend runtime supervisor', () => {
  it.each([
    ['nonzero exit', 'process.exit(7)', 7],
    ['signal exit', "process.kill(process.pid, 'SIGKILL')", 1],
  ] as const)(
    'preserves a child %s after its sibling drains',
    (_label, failure, expected) => {
      const directory = mkdtempSync(
        path.join(tmpdir(), 'daedalus-runtime-test-'),
      );
      try {
        writeFileSync(
          path.join(directory, 'server.js'),
          `
        const fs = require('node:fs');
        process.on('SIGTERM', () => {
          fs.writeFileSync('server-stopped', 'drained');
          process.exit(0);
        });
        fs.writeFileSync('server-ready', 'ready');
        setInterval(() => {}, 1000);
      `,
        );
        writeFileSync(
          path.join(directory, 'ws-server.js'),
          `
        const fs = require('node:fs');
        setInterval(() => {
          if (fs.existsSync('server-ready')) { ${failure}; }
        }, 10);
      `,
        );
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(
              new URL('../../scripts/start-runtime.js', import.meta.url),
            ),
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
            },
            encoding: 'utf8',
            timeout: 10_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(
          readFileSync(path.join(directory, 'server-stopped'), 'utf8'),
        ).toBe('drained');
        expect(result.stderr).toContain('websocket exited unexpectedly');
        expect(result.status).toBe(expected);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
