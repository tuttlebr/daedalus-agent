import {
  StreamWorkerRuntime,
  streamWorkerOptionsFromEnv,
  workerHealthcheck,
  workerReadycheck,
} from './server/chat/streamWorker';

const options = streamWorkerOptionsFromEnv();

if (process.argv.includes('--healthcheck')) {
  process.exit(workerHealthcheck(options.healthMaxAgeMs) ? 0 : 1);
}
if (process.argv.includes('--readycheck')) {
  process.exit(workerReadycheck() ? 0 : 1);
}

const runtime = new StreamWorkerRuntime(options);
let stopping = false;

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await runtime.beginDrain();
}

process.on('SIGTERM', () => {
  void stop();
});
process.on('SIGINT', () => {
  void stop();
});

runtime
  .run()
  .then(() => process.exit(stopping ? 0 : 1))
  .catch((error) => {
    console.error('[stream-worker] fatal error', error);
    process.exit(1);
  });
