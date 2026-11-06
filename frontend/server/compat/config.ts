/**
 * Operator switch for the OpenAI/Anthropic compatible endpoints. Disabled
 * routes answer 404 as if they did not exist, which is also the rollback:
 * the web application and existing integrations do not depend on them.
 */
export function isCompatApiEnabled(): boolean {
  return process.env.DAEDALUS_COMPAT_API_ENABLED === 'true';
}

/** The single advertised agent alias; it uses automatic model selection. */
export const COMPAT_MODEL_ALIAS = 'daedalus';

/** Upper bounds applied before any job is admitted. */
export const COMPAT_LIMITS = {
  maxMessages: 500,
  maxTextBytes: 2 * 1024 * 1024,
  // Small enough to stay inside the backend's default inbound history budget
  // together with the final user turn.
  maxInstructionBytes: 32 * 1024,
  maxOutputTokens: 1_000_000,
  maxIdempotencyKeyLength: 255,
} as const;
