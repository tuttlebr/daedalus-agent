export const JOB_EXPIRY_SECONDS = 60 * 60; // 1 hour
export const NAT_SUBMIT_MAX_RETRIES = Number(
  process.env.NAT_SUBMIT_MAX_RETRIES || 2,
);
export const NAT_RETRY_DELAY_MS = Number(
  process.env.NAT_RETRY_DELAY_MS || 3_000,
);
export const NAT_CONNECTIVITY_TIMEOUT_MS = Number(
  process.env.NAT_CONNECTIVITY_TIMEOUT_MS || 2_000,
);
export const DOCUMENT_INGEST_TIMEOUT_MS = Number(
  process.env.DOCUMENT_INGEST_TIMEOUT_MS || 60 * 60 * 1000,
);
export const NAT_BACKEND_CACHE_TTL_MS = 30_000;
export const STREAM_STATUS_FLUSH_INTERVAL_MS = 750;
export const STREAM_STEPS_FLUSH_INTERVAL_MS = 750;
export const STREAM_ABORT_POLL_INTERVAL_MS = Number(
  process.env.STREAM_ABORT_POLL_INTERVAL_MS || 1_000,
);
export const STREAM_READ_IDLE_TIMEOUT_MS = Number(
  process.env.STREAM_READ_IDLE_TIMEOUT_MS || 5 * 60 * 1000,
);
export const FINALIZER_LOCK_TTL_MS = 30_000;
export const STATUS_UPDATE_LOCK_TTL_MS = 3_000;

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
