import {
  createRecoverableImageJob,
  heartbeatImageJob,
  loadRecoverableImageJob,
  updateOwnedImageJob,
} from '@/server/images/jobRecovery';
import { getRedis } from '@/server/session/redis';

async function main() {
  const [mode, jobId, userId] = process.argv.slice(2);
  if (!process.env.REDIS_URL) throw new Error('Disposable REDIS_URL required');
  if (mode === 'start') {
    await createRecoverableImageJob({
      jobId,
      userId,
      status: 'queued',
      updatedAt: Date.now(),
    });
    const job = await updateOwnedImageJob(jobId, { status: 'running' });
    heartbeatImageJob(jobId, (error) => {
      throw error;
    });
    process.send?.(job);
    setInterval(() => {}, 1000);
  } else {
    process.send?.(await loadRecoverableImageJob(jobId, userId));
    getRedis().disconnect();
    process.disconnect?.();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
