import { COMPAT_LIMITS } from './config';
import { invalidRequest, unsupported } from './errors';
import {
  type NormalizedMessage,
  type NormalizedRequest,
  advisoryNumber,
  advisoryString,
  isPlainObject,
  optionalBoolean,
  rejectUnknownKeys,
  requireMessageArray,
  requireModel,
  validateConversation,
} from './request';

/**
 * Anthropic Messages request contract (see docs/compatibility-api.md).
 *
 * Supported: text content blocks, a string or text-block `system`, streaming,
 * and the required `max_tokens` final-answer limit. Sampling hints and cache
 * markers are accepted as advisory. Tools, images, documents, thinking, stop
 * sequences and beta features are rejected before any job is admitted.
 */

/**
 * `anthropic-version` values whose request/response shapes are served.
 * 2026-10-21 (sent by @anthropic-ai/sdk 1.x) rejects `temperature`, `top_p`
 * and `top_k`; 2023-06-01 accepts them, and here they are advisory.
 */
export const SUPPORTED_ANTHROPIC_VERSIONS: ReadonlySet<string> = new Set([
  '2023-06-01',
  '2026-10-21',
]);
const SAMPLING_REMOVED_IN = '2026-10-21';

function versionHeader(
  headers: Record<string, string | string[] | undefined>,
): string {
  const value = headers['anthropic-version'];
  return (Array.isArray(value) ? value[0] : value ?? '').trim();
}

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
]);

const TEXT_BLOCK_KEYS = new Set(['type', 'text', 'cache_control', 'citations']);

function isUnset(value: unknown): boolean {
  return value === undefined || value === null;
}

function textBlocks(
  value: unknown,
  path: string,
  ignored: Set<string>,
): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) {
    throw invalidRequest(
      `${path} must be a string or an array of text blocks.`,
      path,
    );
  }
  const texts: string[] = [];
  value.forEach((block, index) => {
    const blockPath = `${path}.${index}`;
    if (!isPlainObject(block) || typeof block.type !== 'string') {
      throw invalidRequest(`${blockPath} must be a content block.`, blockPath);
    }
    if (block.type !== 'text') {
      throw unsupported(
        `${blockPath}.type`,
        `Content block type '${block.type}' is not supported; send text blocks only.`,
      );
    }
    rejectUnknownKeys(block, TEXT_BLOCK_KEYS, blockPath);
    if (typeof block.text !== 'string') {
      throw invalidRequest(`${blockPath}.text must be a string.`, blockPath);
    }
    if (!isUnset(block.cache_control)) {
      if (!isPlainObject(block.cache_control)) {
        throw invalidRequest(
          `${blockPath}.cache_control must be an object.`,
          blockPath,
        );
      }
      ignored.add('cache_control');
    }
    if (
      !isUnset(block.citations) &&
      !(Array.isArray(block.citations) && block.citations.length === 0)
    ) {
      throw unsupported(`${blockPath}.citations`);
    }
    texts.push(block.text);
  });
  return texts.join('\n');
}

/**
 * Header contract: a supported `anthropic-version` is required, and beta
 * features are refused explicitly rather than silently disabled.
 */
export function validateAnthropicHeaders(
  headers: Record<string, string | string[] | undefined>,
): void {
  const version = versionHeader(headers);
  if (!version) {
    throw invalidRequest(
      'anthropic-version: header is required.',
      'anthropic-version',
      'missing_required',
    );
  }
  if (!SUPPORTED_ANTHROPIC_VERSIONS.has(version)) {
    throw invalidRequest(
      `anthropic-version '${version.slice(
        0,
        64,
      )}' is not supported. Supported: ${[...SUPPORTED_ANTHROPIC_VERSIONS].join(
        ', ',
      )}.`,
      'anthropic-version',
    );
  }
  const beta = headers['anthropic-beta'];
  const betaValue = Array.isArray(beta) ? beta.join(',') : beta;
  if (typeof betaValue === 'string' && betaValue.trim()) {
    throw unsupported(
      'anthropic-beta',
      `Beta features are not supported: ${betaValue.slice(0, 200)}.`,
    );
  }
}

export function parseAnthropicMessagesRequest(
  body: unknown,
  headers: Record<string, string | string[] | undefined> = {},
): NormalizedRequest {
  if (!isPlainObject(body)) {
    throw invalidRequest('The request body must be a JSON object.');
  }
  rejectUnknownKeys(body, TOP_LEVEL_KEYS, '');
  const model = requireModel(body.model);

  const maxTokens = body.max_tokens;
  if (
    typeof maxTokens !== 'number' ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > COMPAT_LIMITS.maxOutputTokens
  ) {
    throw invalidRequest(
      `max_tokens is required and must be an integer between 1 and ${COMPAT_LIMITS.maxOutputTokens}.`,
      'max_tokens',
    );
  }

  const ignored = new Set<string>();
  const messages: NormalizedMessage[] = [];
  requireMessageArray(body.messages).forEach((raw, index) => {
    const path = `messages.${index}`;
    if (!isPlainObject(raw)) {
      throw invalidRequest(`${path} must be an object.`, path);
    }
    rejectUnknownKeys(raw, new Set(['role', 'content']), path);
    if (raw.role !== 'user' && raw.role !== 'assistant') {
      throw invalidRequest(
        `${path}.role must be 'user' or 'assistant'.`,
        `${path}.role`,
      );
    }
    const content = textBlocks(raw.content, `${path}.content`, ignored);
    if (raw.role === 'assistant' && !content.trim()) {
      throw invalidRequest(
        `${path} must contain assistant text.`,
        `${path}.content`,
      );
    }
    messages.push({ role: raw.role, content });
  });

  const instructions = isUnset(body.system)
    ? null
    : textBlocks(body.system, 'system', ignored).trim() || null;
  validateConversation(messages, instructions);

  for (const key of ['container', 'mcp_servers', 'context_management']) {
    if (!isUnset(body[key])) throw unsupported(key);
  }
  if (
    !isUnset(body.stop_sequences) &&
    !(Array.isArray(body.stop_sequences) && body.stop_sequences.length === 0)
  ) {
    throw unsupported('stop_sequences');
  }
  if (
    !isUnset(body.tools) &&
    !(Array.isArray(body.tools) && body.tools.length === 0)
  ) {
    throw unsupported(
      'tools',
      'Client-defined tools are not supported: Daedalus uses its own authorized server-side tools.',
    );
  }
  if (!isUnset(body.tool_choice)) {
    const choice = body.tool_choice;
    if (
      !isPlainObject(choice) ||
      (choice.type !== 'auto' && choice.type !== 'none')
    ) {
      throw unsupported('tool_choice');
    }
  }
  if (!isUnset(body.thinking)) {
    if (!isPlainObject(body.thinking) || body.thinking.type !== 'disabled') {
      throw unsupported(
        'thinking',
        'Extended thinking is not supported; Daedalus keeps its reasoning internal.',
      );
    }
  }
  if (!isUnset(body.service_tier)) {
    if (body.service_tier !== 'auto' && body.service_tier !== 'standard_only') {
      throw unsupported('service_tier');
    }
    ignored.add('service_tier');
  }
  if (!isUnset(body.metadata)) {
    if (!isPlainObject(body.metadata)) {
      throw invalidRequest('metadata must be an object.', 'metadata');
    }
    rejectUnknownKeys(body.metadata, new Set(['user_id']), 'metadata');
    const userIgnored: string[] = [];
    advisoryString(body.metadata, 'user_id', userIgnored, 256);
    ignored.add('metadata');
  }

  if (versionHeader(headers) >= SAMPLING_REMOVED_IN) {
    for (const key of ['temperature', 'top_p', 'top_k']) {
      if (body[key] !== undefined) {
        throw invalidRequest(
          `${key}: Extra inputs are not permitted in anthropic-version ${SAMPLING_REMOVED_IN}.`,
          key,
          'unsupported_parameter',
        );
      }
    }
  }
  const advisory: string[] = [];
  advisoryNumber(body, 'temperature', 0, 1, advisory);
  advisoryNumber(body, 'top_p', 0, 1, advisory);
  advisoryNumber(body, 'top_k', 0, Number.MAX_SAFE_INTEGER, advisory, true);
  advisory.forEach((key) => ignored.add(key));

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
