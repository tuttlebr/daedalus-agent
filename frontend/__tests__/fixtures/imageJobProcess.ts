import {
  createRecoverableImageJob,
  heartbeatImageJob,
  loadRecoverableImageJob,
  updateOwnedImageJob,
  watchImageJobCancellation,
} from '@/server/images/jobRecovery';
import { getRedis } from '@/server/session/redis';

async function main() {
  const [mode, jobId, userId] = process.argv.slice(2);
  if (!process.env.REDIS_URL) throw new Error('Disposable REDIS_URL required');
  if (mode === 'start' || mode === 'watch') {
    await createRecoverableImageJob({
      jobId,
      userId,
      status: 'queued',
      updatedAt: Date.now(),
    });
    const job = await updateOwnedImageJob(jobId, { status: 'running' });
    const stopHeartbeat = heartbeatImageJob(jobId, (error) => {
      throw error;
    });
    process.send?.(job);
    if (mode === 'watch') {
      const stopWatch = watchImageJobCancellation(jobId, () => {
        stopWatch();
        stopHeartbeat();
        void updateOwnedImageJob(jobId, { status: 'completed' }).then(
          (completed) => {
            process.send?.({ cancelled: true, completed });
            getRedis().disconnect();
            process.disconnect?.();
          },
        );
      });
    } else setInterval(() => {}, 1000);
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
