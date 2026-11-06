import { COMPAT_LIMITS, COMPAT_MODEL_ALIAS } from './config';
import { CompatError, invalidRequest } from './errors';

export type CompatProtocol = 'openai' | 'anthropic';

export interface NormalizedMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A validated compatibility request, independent of its wire format. Nothing
 * here can carry identity, tool permissions or approvals: caller instructions
 * become a subordinate model-input message (see submitChatJob).
 */
export interface NormalizedRequest {
  protocol: CompatProtocol;
  model: string;
  messages: NormalizedMessage[];
  instructions: string | null;
  stream: boolean;
  /** OpenAI `stream_options.include_usage`; Anthropic always reports usage. */
  includeUsage: boolean;
  /** Final-answer budget; null when the caller set none (OpenAI only). */
  maxOutputTokens: number | null;
  /** Accepted parameters that cannot affect the agent, for the response header. */
  ignoredParameters: string[];
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function requireModel(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw invalidRequest('model is required.', 'model', 'missing_required');
  }
  if (value !== COMPAT_MODEL_ALIAS) {
    throw new CompatError(
      'not_found',
      `The model '${value.slice(
        0,
        128,
      )}' does not exist. Use '${COMPAT_MODEL_ALIAS}'.`,
      { param: 'model', code: 'model_not_found' },
    );
  }
  return value;
}

export function optionalBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw invalidRequest(`'${key}' must be a boolean.`, key);
  }
  return value;
}

export function optionalPositiveInteger(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > COMPAT_LIMITS.maxOutputTokens
  ) {
    throw invalidRequest(
      `'${key}' must be an integer between 1 and ${COMPAT_LIMITS.maxOutputTokens}.`,
      key,
    );
  }
  return value;
}

/** Validate an advisory numeric parameter's range before accepting it. */
export function advisoryNumber(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  ignored: string[],
  integer = false,
): void {
  const value = body[key];
  if (value === undefined || value === null) return;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value)) ||
    value < min ||
    value > max
  ) {
    throw invalidRequest(
      `'${key}' must be ${
        integer ? 'an integer' : 'a number'
      } between ${min} and ${max}.`,
      key,
    );
  }
  ignored.push(key);
}

export function advisoryString(
  body: Record<string, unknown>,
  key: string,
  ignored: string[],
  maxLength = 512,
): void {
  const value = body[key];
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw invalidRequest(
      `'${key}' must be a string of at most ${maxLength} characters.`,
      key,
    );
  }
  ignored.push(key);
}

/** Reject keys outside the documented set, as the vendor APIs do. */
export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidRequest(
        path
          ? `Unrecognized field '${key}' in ${path}.`
          : `Unrecognized request argument supplied: ${key}`,
        path ? `${path}.${key}` : key,
        'unknown_parameter',
      );
    }
  }
}

/** Check the bounded history and the final user turn shared by both APIs. */
export function validateConversation(
  messages: NormalizedMessage[],
  instructions: string | null,
): void {
  if (!messages.length) {
    throw invalidRequest(
      'messages must include at least one user message.',
      'messages',
    );
  }
  const last = messages[messages.length - 1];
  if (last.role !== 'user' || !last.content.trim()) {
    throw invalidRequest(
      'The last message must be a user message with text. Assistant prefill is not supported.',
      'messages',
    );
  }
  let bytes = 0;
  for (const message of messages) bytes += Buffer.byteLength(message.content);
  if (bytes > COMPAT_LIMITS.maxTextBytes) {
    throw new CompatError(
      'request_too_large',
      `Message text exceeds ${COMPAT_LIMITS.maxTextBytes} bytes.`,
      { param: 'messages', code: 'request_too_large' },
    );
  }
  if (
    instructions &&
    Buffer.byteLength(instructions) > COMPAT_LIMITS.maxInstructionBytes
  ) {
    throw new CompatError(
      'request_too_large',
      `Instructions exceed ${COMPAT_LIMITS.maxInstructionBytes} bytes.`,
      { param: 'system', code: 'request_too_large' },
    );
  }
}

export function requireMessageArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequest('messages must be a non-empty array.', 'messages');
  }
  if (value.length > COMPAT_LIMITS.maxMessages) {
    throw new CompatError(
      'request_too_large',
      `messages may contain at most ${COMPAT_LIMITS.maxMessages} entries.`,
      { param: 'messages', code: 'request_too_large' },
    );
  }
  return value;
}
