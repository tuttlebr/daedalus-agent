// @vitest-environment node
import { build } from 'esbuild';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'image job process recovery with real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let recovery: typeof import('@/server/images/jobRecovery');
    let directory: string;
    let executable: string;
    const children: ChildProcess[] = [];
    const keys: string[] = [];
    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('Disposable REDIS_URL required');
      redis = await import('@/server/session/redis');
      recovery = await import('@/server/images/jobRecovery');
      await redis.getRedis().ping();
      directory = await mkdtemp(path.join(tmpdir(), 'daedalus-image-process-'));
      executable = path.join(directory, 'worker.cjs');
      await build({
        entryPoints: [path.resolve('__tests__/fixtures/imageJobProcess.ts')],
        outfile: executable,
        bundle: true,
        platform: 'node',
        target: 'node22',
        alias: { '@': process.cwd() },
      });
    });
    afterAll(async () => {
      for (const child of children)
        if (child.exitCode === null) child.kill('SIGKILL');
      if (redis) {
        if (keys.length) await redis.getRedis().del(...keys);
        redis.getRedis().disconnect();
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    function run(
      mode: string,
      id: string,
      user: string,
    ): Promise<{ child: ChildProcess; job: any }> {
      const child = fork(executable, [mode, id, user], {
        env: process.env,
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      return new Promise((resolve, reject) => {
        child.once('message', (job) => resolve({ child, job }));
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code) reject(new Error(`Image fixture exited ${code}`));
        });
      });
    }
    it('classifies a killed owner after its real lease expires, without replaying work', async () => {
      const id = `image-process-${process.pid}-${Date.now()}`;
      const user = `user-${id}`;
      keys.push(recovery.imageJobKey(id));
      const { child, job } = await run('start', id, user);
      expect(job.status).toBe('running');
      await new Promise((resolve) => setTimeout(resolve, 16_000));
      const renewed = await redis.jsonGet(recovery.imageJobKey(id));
      expect(renewed.leaseExpiresAt).toBeGreaterThan(job.leaseExpiresAt);
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      expect(
        await recovery.loadRecoverableImageJob(id, 'other-user'),
      ).toBeNull();
      expect(
        await recovery.updateOwnedImageJob(id, { status: 'completed' }),
      ).toBeNull();
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, renewed.leaseExpiresAt - Date.now()) + 25,
        ),
      );
      const restarted = await run('recover', id, user);
      expect(restarted.job.status).toBe('error');
      expect(restarted.job.error).toContain('result is unconfirmed');
      expect(
        await recovery.updateOwnedImageJob(id, { status: 'completed' }),
      ).toBeNull();
      expect((await redis.jsonGet(recovery.imageJobKey(id))).status).toBe(
        'error',
      );
    }, 110_000);

    it('recovers expired legacy jobs but allows their original execution budget', async () => {
      for (const [age, expected] of [
        [400_000, 'error'],
        [1000, 'running'],
      ] as const) {
        const id = `legacy-image-${age}-${process.pid}`;
        const key = recovery.imageJobKey(id);
        keys.push(key);
        await redis.jsonSetWithExpiry(
          key,
          {
            jobId: id,
            userId: 'legacy',
            status: 'running',
            updatedAt: Date.now() - age,
          },
          3600,
        );
        expect(
          (await recovery.loadRecoverableImageJob(id, 'legacy'))?.status,
        ).toBe(expected);
      }
    });
  },
);
