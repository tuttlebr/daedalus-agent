import { COMPAT_MODEL_ALIAS } from './config';
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
  optionalPositiveInteger,
  rejectUnknownKeys,
  requireMessageArray,
  requireModel,
} from './request';

/** Vendor controls are accepted as advisory; only text enters the agent. */
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
  'moderation',
  'prompt_cache_options',
  'prompt_cache_retention',
]);

export function parseOpenAIChatRequest(body: unknown): NormalizedRequest {
  if (!isPlainObject(body))
    throw invalidRequest('The request body must be a JSON object.');
  rejectUnknownKeys(body, TOP_LEVEL_KEYS, '');
  const model = requireModel(body.model);
  const ignored = ignoredFields(body, [
    'model',
    'messages',
    'stream',
    'stream_options',
    'max_tokens',
    'max_completion_tokens',
  ]);
  if (body.model !== COMPAT_MODEL_ALIAS) ignored.add('model');
  const messages: NormalizedMessage[] = [];
  const system: string[] = [];
  requireMessageArray(body.messages).forEach((raw, index) => {
    const path = `messages[${index}]`;
    if (
      !isPlainObject(raw) ||
      ![
        'user',
        'assistant',
        'system',
        'developer',
        'tool',
        'function',
      ].includes(String(raw.role))
    ) {
      throw invalidRequest(`${path} must have a valid role.`, `${path}.role`);
    }
    for (const key of Object.keys(raw)) {
      if (!['role', 'content', 'refusal'].includes(key))
        ignored.add('messages');
    }
    const content =
      compatibilityText(raw.content, 'messages.content', ignored) ||
      (typeof raw.refusal === 'string' ? raw.refusal : '');
    if (raw.role === 'system' || raw.role === 'developer') {
      if (content) system.push(content);
    } else {
      if (raw.role === 'tool' || raw.role === 'function')
        ignored.add('messages.role');
      if (content || raw.role === 'user')
        messages.push({
          role: raw.role === 'assistant' ? 'assistant' : 'user',
          content,
        });
    }
  });
  const instructions = system.join('\n\n') || null;
  completeConversation(messages, instructions);
  const stream = optionalBoolean(body, 'stream') ?? false;
  let includeUsage = false;
  if (body.stream_options != null) {
    if (!isPlainObject(body.stream_options))
      throw invalidRequest(
        'stream_options must be an object.',
        'stream_options',
      );
    includeUsage =
      optionalBoolean(body.stream_options, 'include_usage') ?? false;
    if (
      !stream ||
      Object.keys(body.stream_options).some((key) => key !== 'include_usage')
    )
      ignored.add('stream_options');
  }
  const maxCompletion = optionalPositiveInteger(body, 'max_completion_tokens');
  const maxTokens = optionalPositiveInteger(body, 'max_tokens');
  if (maxCompletion !== undefined && maxTokens !== undefined)
    ignored.add('max_tokens');
  advisoryNumber(body, 'temperature', 0, 2, []);
  advisoryNumber(body, 'top_p', 0, 1, []);
  advisoryNumber(body, 'presence_penalty', -2, 2, []);
  advisoryNumber(body, 'frequency_penalty', -2, 2, []);
  return {
    protocol: 'openai',
    model,
    messages,
    instructions,
    stream,
    includeUsage,
    maxOutputTokens: maxCompletion ?? maxTokens ?? null,
    ignoredParameters: [...ignored],
  };
}
