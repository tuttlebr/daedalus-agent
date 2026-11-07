import { COMPAT_MODEL_ALIAS, COMPAT_LIMITS } from './config';
import {
  compatibilityText,
  completeConversation,
  ignoredFields,
} from './content';
import { CompatError, invalidRequest } from './errors';
import {
  type NormalizedMessage,
  type NormalizedRequest,
  isPlainObject,
  optionalBoolean,
  optionalPositiveInteger,
  rejectUnknownKeys,
  requireModel,
} from './request';

const TOP_LEVEL_KEYS = new Set([
  'access_programs',
  'background',
  'context_management',
  'conversation',
  'image',
  'include',
  'input',
  'instructions',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'model',
  'moderation',
  'parallel_tool_calls',
  'previous_response_id',
  'prompt',
  'prompt_cache_key',
  'prompt_cache_options',
  'prompt_cache_retention',
  'reasoning',
  'safety_identifier',
  'service_tier',
  'store',
  'stream',
  'stream_options',
  'temperature',
  'text',
  'tool_choice',
  'tools',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
]);

export function parseResponsesRequest(body: unknown): NormalizedRequest {
  if (!isPlainObject(body))
    throw invalidRequest('The request body must be a JSON object.');
  rejectUnknownKeys(body, TOP_LEVEL_KEYS, '');
  const model =
    body.model == null ? COMPAT_MODEL_ALIAS : requireModel(body.model);
  const ignored = ignoredFields(body, [
    'model',
    'input',
    'instructions',
    'stream',
    'max_output_tokens',
  ]);
  if (body.model != null && body.model !== COMPAT_MODEL_ALIAS)
    ignored.add('model');
  const messages: NormalizedMessage[] = [];
  const system: string[] = [];
  if (body.instructions != null) {
    if (typeof body.instructions !== 'string')
      throw invalidRequest('instructions must be a string.', 'instructions');
    system.push(body.instructions);
  }
  if (typeof body.input === 'string')
    messages.push({ role: 'user', content: body.input });
  else if (body.input != null) {
    if (!Array.isArray(body.input))
      throw invalidRequest('input must be a string or array.', 'input');
    if (body.input.length > COMPAT_LIMITS.maxMessages)
      throw new CompatError('request_too_large', 'Too many input items.', {
        param: 'input',
      });
    for (const item of body.input) {
      if (!isPlainObject(item))
        throw invalidRequest('input items must be objects.', 'input');
      if (
        Object.keys(item).some(
          (key) => !['type', 'role', 'content'].includes(key),
        )
      )
        ignored.add('input');
      if (
        item.type === 'message' ||
        (item.type === undefined && item.role !== undefined)
      ) {
        if (
          !['user', 'assistant', 'system', 'developer'].includes(
            String(item.role),
          )
        )
          throw invalidRequest('Invalid input message role.', 'input.role');
        const content = compatibilityText(
          item.content,
          'input.content',
          ignored,
        );
        if (item.role === 'system' || item.role === 'developer')
          system.push(content);
        else if (content || item.role === 'user')
          messages.push({
            role: item.role === 'assistant' ? 'assistant' : 'user',
            content,
          });
      } else if (
        item.type === 'function_call_output' ||
        item.type === 'custom_tool_call_output'
      ) {
        // Already supplied results are untrusted conversation text, never tool execution.
        const content = compatibilityText(item.output, 'input.output', ignored);
        if (content) messages.push({ role: 'user', content });
        ignored.add('input.tool_calls');
      } else {
        if (typeof item.type !== 'string')
          throw invalidRequest(
            'input items must have a type or role.',
            'input',
          );
        ignored.add('input');
      }
    }
  }
  const instructions = system.filter(Boolean).join('\n\n') || null;
  completeConversation(messages, instructions);
  return {
    protocol: 'openai',
    model,
    messages,
    instructions,
    stream: optionalBoolean(body, 'stream') ?? false,
    includeUsage: true,
    maxOutputTokens: optionalPositiveInteger(body, 'max_output_tokens') ?? null,
    ignoredParameters: [...ignored],
  };
}
