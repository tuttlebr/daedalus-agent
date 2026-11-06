import { invalidRequest, unsupported } from './errors';
import {
  type NormalizedMessage,
  type NormalizedRequest,
  advisoryNumber,
  advisoryString,
  isPlainObject,
  optionalBoolean,
  optionalPositiveInteger,
  rejectUnknownKeys,
  requireMessageArray,
  requireModel,
  validateConversation,
} from './request';

/**
 * OpenAI Chat Completions request contract (see docs/compatibility-api.md).
 *
 * Supported: text messages, system/developer instructions, streaming with
 * optional usage, and a final-answer token limit. Sampling hints the agent
 * cannot apply are accepted, validated and reported as ignored. Client tools,
 * non-text content, structured output, logprobs and stored completions are
 * rejected before any job is admitted.
 */

const TOP_LEVEL_KEYS = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'max_tokens',
  'max_completion_tokens',
  'n',
  'store',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'response_format',
  'modalities',
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'parallel_tool_calls',
  'service_tier',
  'metadata',
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'user',
  'prompt_cache_key',
  'safety_identifier',
  'stop',
  'audio',
  'prediction',
  'reasoning_effort',
  'verbosity',
  'web_search_options',
]);

// Recognized vendor features this release does not provide.
const REJECTED_WHEN_SET = [
  'stop',
  'audio',
  'prediction',
  'reasoning_effort',
  'verbosity',
  'web_search_options',
  'top_logprobs',
] as const;

const MESSAGE_KEYS: Record<string, ReadonlySet<string>> = {
  system: new Set(['role', 'content']),
  developer: new Set(['role', 'content']),
  user: new Set(['role', 'content']),
  assistant: new Set([
    'role',
    'content',
    'refusal',
    'tool_calls',
    'function_call',
    'audio',
    'annotations',
  ]),
};

function isUnset(value: unknown): boolean {
  return value === undefined || value === null;
}

function isEmptyList(value: unknown): boolean {
  return isUnset(value) || (Array.isArray(value) && value.length === 0);
}

function textContent(value: unknown, path: string): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) {
    throw invalidRequest(
      `${path} must be a string or an array of text parts.`,
      path,
    );
  }
  const texts: string[] = [];
  value.forEach((part, index) => {
    const partPath = `${path}[${index}]`;
    if (!isPlainObject(part) || typeof part.type !== 'string') {
      throw invalidRequest(`${partPath} must be a content part.`, partPath);
    }
    if (part.type !== 'text') {
      throw unsupported(
        `${partPath}.type`,
        `Content type '${part.type}' is not supported; send text parts only.`,
      );
    }
    rejectUnknownKeys(part, new Set(['type', 'text']), partPath);
    if (typeof part.text !== 'string') {
      throw invalidRequest(`${partPath}.text must be a string.`, partPath);
    }
    texts.push(part.text);
  });
  return texts.join('\n');
}

function parseMessages(value: unknown): {
  messages: NormalizedMessage[];
  instructions: string | null;
} {
  const messages: NormalizedMessage[] = [];
  const instructions: string[] = [];
  requireMessageArray(value).forEach((raw, index) => {
    const path = `messages[${index}]`;
    if (!isPlainObject(raw) || typeof raw.role !== 'string') {
      throw invalidRequest(`${path} must be an object with a role.`, path);
    }
    const role = raw.role;
    if (role === 'tool' || role === 'function') {
      throw unsupported(
        `${path}.role`,
        `Role '${role}' is not supported: Daedalus runs its own server-side tools and does not accept client tool results.`,
      );
    }
    const allowed = MESSAGE_KEYS[role];
    if (!allowed) {
      throw invalidRequest(
        `Invalid role '${role}' in ${path}.`,
        `${path}.role`,
      );
    }
    if ('name' in raw) {
      throw unsupported(
        `${path}.name`,
        'Participant names are not supported; include names in the message text.',
      );
    }
    rejectUnknownKeys(raw, allowed, path);
    if (role === 'assistant') {
      if (!isEmptyList(raw.tool_calls) || !isUnset(raw.function_call)) {
        throw unsupported(
          `${path}.tool_calls`,
          'Assistant tool calls are not supported: Daedalus runs its own server-side tools.',
        );
      }
      if (!isUnset(raw.audio)) throw unsupported(`${path}.audio`);
      if (!isUnset(raw.refusal) && typeof raw.refusal !== 'string') {
        throw invalidRequest(`${path}.refusal must be a string.`, path);
      }
      if (!isEmptyList(raw.annotations)) {
        throw unsupported(`${path}.annotations`);
      }
      // A refusal is the assistant's visible reply when content is absent.
      const content = isUnset(raw.content)
        ? typeof raw.refusal === 'string'
          ? raw.refusal
          : ''
        : textContent(raw.content, `${path}.content`);
      if (!content.trim()) {
        throw invalidRequest(
          `${path} must contain assistant text.`,
          `${path}.content`,
        );
      }
      messages.push({ role: 'assistant', content });
      return;
    }
    const content = textContent(raw.content, `${path}.content`);
    if (role === 'system' || role === 'developer') {
      if (content.trim()) instructions.push(content);
      return;
    }
    messages.push({ role: 'user', content });
  });
  return {
    messages,
    instructions: instructions.length ? instructions.join('\n\n') : null,
  };
}

export function parseOpenAIChatRequest(body: unknown): NormalizedRequest {
  if (!isPlainObject(body)) {
    throw invalidRequest('The request body must be a JSON object.');
  }
  rejectUnknownKeys(body, TOP_LEVEL_KEYS, '');
  const model = requireModel(body.model);
  const { messages, instructions } = parseMessages(body.messages);
  validateConversation(messages, instructions);

  const ignored: string[] = [];
  const stream = optionalBoolean(body, 'stream') ?? false;

  let includeUsage = false;
  if (!isUnset(body.stream_options)) {
    if (!stream) {
      throw invalidRequest(
        'stream_options is only allowed when stream is true.',
        'stream_options',
      );
    }
    if (!isPlainObject(body.stream_options)) {
      throw invalidRequest(
        'stream_options must be an object.',
        'stream_options',
      );
    }
    rejectUnknownKeys(
      body.stream_options,
      new Set(['include_usage']),
      'stream_options',
    );
    includeUsage =
      optionalBoolean(body.stream_options, 'include_usage') ?? false;
  }

  const maxCompletion = optionalPositiveInteger(body, 'max_completion_tokens');
  const maxTokens = optionalPositiveInteger(body, 'max_tokens');
  if (maxCompletion !== undefined && maxTokens !== undefined) {
    throw invalidRequest(
      'Set either max_completion_tokens or max_tokens, not both.',
      'max_tokens',
    );
  }

  for (const key of REJECTED_WHEN_SET) {
    if (!isUnset(body[key])) throw unsupported(key);
  }
  if (!isUnset(body.n) && body.n !== 1) {
    throw unsupported('n', "Only one choice ('n': 1) is supported.");
  }
  if (!isUnset(body.store) && body.store !== false) {
    throw unsupported('store', 'Stored completions are not supported.');
  }
  if (!isUnset(body.logprobs) && body.logprobs !== false) {
    throw unsupported('logprobs');
  }
  if (
    !isUnset(body.logit_bias) &&
    !(isPlainObject(body.logit_bias) && !Object.keys(body.logit_bias).length)
  ) {
    throw unsupported('logit_bias');
  }
  if (
    !isUnset(body.response_format) &&
    !(
      isPlainObject(body.response_format) &&
      body.response_format.type === 'text' &&
      Object.keys(body.response_format).length === 1
    )
  ) {
    throw unsupported(
      'response_format',
      "Structured output is not supported; only response_format {'type': 'text'} is accepted.",
    );
  }
  if (
    !isUnset(body.modalities) &&
    !(
      Array.isArray(body.modalities) &&
      body.modalities.length === 1 &&
      body.modalities[0] === 'text'
    )
  ) {
    throw unsupported('modalities', "Only the 'text' modality is supported.");
  }
  if (!isEmptyList(body.tools) || !isEmptyList(body.functions)) {
    throw unsupported(
      isEmptyList(body.tools) ? 'functions' : 'tools',
      'Client-defined tools are not supported: Daedalus uses its own authorized server-side tools.',
    );
  }
  if (
    !isUnset(body.tool_choice) &&
    body.tool_choice !== 'none' &&
    body.tool_choice !== 'auto'
  ) {
    throw unsupported('tool_choice');
  }
  if (!isUnset(body.function_call) && body.function_call !== 'none') {
    throw unsupported('function_call');
  }
  if (
    !isUnset(body.service_tier) &&
    body.service_tier !== 'auto' &&
    body.service_tier !== 'default'
  ) {
    throw unsupported('service_tier');
  }
  if (!isUnset(body.metadata)) {
    if (
      !isPlainObject(body.metadata) ||
      Object.values(body.metadata).some((value) => typeof value !== 'string')
    ) {
      throw invalidRequest(
        'metadata must be an object of strings.',
        'metadata',
      );
    }
    ignored.push('metadata');
  }

  advisoryNumber(body, 'temperature', 0, 2, ignored);
  advisoryNumber(body, 'top_p', 0, 1, ignored);
  advisoryNumber(body, 'presence_penalty', -2, 2, ignored);
  advisoryNumber(body, 'frequency_penalty', -2, 2, ignored);
  advisoryNumber(
    body,
    'seed',
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    ignored,
    true,
  );
  advisoryString(body, 'user', ignored);
  advisoryString(body, 'prompt_cache_key', ignored);
  advisoryString(body, 'safety_identifier', ignored);
  if (optionalBoolean(body, 'parallel_tool_calls') !== undefined) {
    ignored.push('parallel_tool_calls');
  }

  return {
    protocol: 'openai',
    model,
    messages,
    instructions,
    stream,
    includeUsage,
    maxOutputTokens: maxCompletion ?? maxTokens ?? null,
    ignoredParameters: ignored,
  };
}
