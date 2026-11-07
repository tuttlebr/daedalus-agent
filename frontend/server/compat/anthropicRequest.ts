import { COMPAT_LIMITS, COMPAT_MODEL_ALIAS } from './config';
import {
  compatibilityText,
  completeConversation,
  ignoredFields,
} from './content';
import { invalidRequest } from './errors';
import {
  type NormalizedMessage,
  type NormalizedRequest,
  advisoryNumber,
  isPlainObject,
  optionalBoolean,
  rejectUnknownKeys,
  requireMessageArray,
  requireModel,
} from './request';

export const SUPPORTED_ANTHROPIC_VERSIONS: ReadonlySet<string> = new Set([
  '2023-06-01',
  '2026-10-21',
]);
const TOP_LEVEL_KEYS = new Set([
  'model',
  'messages',
  'max_tokens',
  'system',
  'stream',
  'temperature',
  'top_p',
  'top_k',
  'metadata',
  'stop_sequences',
  'tools',
  'tool_choice',
  'thinking',
  'service_tier',
  'container',
  'mcp_servers',
  'context_management',
  'cache_control',
  'diagnostics',
  'inference_geo',
  'output_config',
  'speed',
  'output_format',
]);

/** Version and beta headers select vendor features, not Daedalus permissions. */
export function validateAnthropicHeaders(
  headers: Record<string, string | string[] | undefined>,
): void {
  const version = headers['anthropic-version'];
  if (
    version !== undefined &&
    (typeof version !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(version))
  ) {
    throw invalidRequest(
      'anthropic-version must be a date.',
      'anthropic-version',
    );
  }
}

export function parseAnthropicMessagesRequest(
  body: unknown,
  headers: Record<string, string | string[] | undefined> = {},
): NormalizedRequest {
  if (!isPlainObject(body))
    throw invalidRequest('The request body must be a JSON object.');
  rejectUnknownKeys(body, TOP_LEVEL_KEYS, '');
  const model = requireModel(body.model);
  const maxTokens = body.max_tokens;
  if (
    typeof maxTokens !== 'number' ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 0 ||
    maxTokens > COMPAT_LIMITS.maxOutputTokens
  ) {
    throw invalidRequest(
      `max_tokens is required and must be an integer between 0 and ${COMPAT_LIMITS.maxOutputTokens}.`,
      'max_tokens',
    );
  }
  const ignored = ignoredFields(body, [
    'model',
    'messages',
    'max_tokens',
    'system',
    'stream',
  ]);
  if (body.model !== COMPAT_MODEL_ALIAS) ignored.add('model');
  for (const key of [
    'anthropic-beta',
    'anthropic-user-profile-id',
    'anthropic-workspace-id',
  ]) {
    if (headers[key]) ignored.add(key);
  }
  const version = headers['anthropic-version'];
  if (typeof version === 'string' && !SUPPORTED_ANTHROPIC_VERSIONS.has(version))
    ignored.add('anthropic-version');
  const messages: NormalizedMessage[] = [];
  requireMessageArray(body.messages).forEach((raw, index) => {
    const path = `messages.${index}`;
    if (!isPlainObject(raw))
      throw invalidRequest(`${path} must be an object.`, path);
    if (raw.role !== 'user' && raw.role !== 'assistant')
      throw invalidRequest(
        `${path}.role must be 'user' or 'assistant'.`,
        `${path}.role`,
      );
    const content = compatibilityText(raw.content, 'messages.content', ignored);
    if (content || raw.role === 'user')
      messages.push({ role: raw.role, content });
  });
  const instructions =
    compatibilityText(body.system, 'system', ignored).trim() || null;
  completeConversation(messages, instructions);
  advisoryNumber(body, 'temperature', 0, 1, []);
  advisoryNumber(body, 'top_p', 0, 1, []);
  advisoryNumber(body, 'top_k', 0, Number.MAX_SAFE_INTEGER, [], true);
  return {
    protocol: 'anthropic',
    model,
    messages,
    instructions,
    stream: optionalBoolean(body, 'stream') ?? false,
    includeUsage: true,
    maxOutputTokens: maxTokens,
    ignoredParameters: [...ignored],
  };
}
