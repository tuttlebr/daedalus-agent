import { Logger } from '@/utils/logger';

import { createHash } from 'node:crypto';

const logger = new Logger('AsyncJob');

// Diagnostics gated by DAEDALUS_DEBUG_REPLAY=1. Captures outbound /v1/chat/completions
// payload and raw inbound stream so we can verify whether prior assistant content reaches
// the model. Cap emissions to avoid disk floods if the env var is left enabled.
export const DEBUG_REPLAY_ENABLED = process.env.DAEDALUS_DEBUG_REPLAY === '1';
const DEBUG_REPLAY_MAX_EMISSIONS = 200;
let debugReplayEmissionCount = 0;

export function debugReplayHash(content: string): string {
  if (!content) return '';
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function debugReplayLog(
  label: string,
  fields: Record<string, any>,
): void {
  if (!DEBUG_REPLAY_ENABLED) return;
  if (debugReplayEmissionCount >= DEBUG_REPLAY_MAX_EMISSIONS) return;
  debugReplayEmissionCount += 1;
  logger.info(`[replay-debug] ${label}`, fields);
}
