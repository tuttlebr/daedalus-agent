import { invalidRequest } from './errors';
import {
  isPlainObject,
  type NormalizedMessage,
  validateConversation,
} from './request';

/** Extract caller-supplied text only. Never resolve vendor IDs, URLs or tools. */
export function compatibilityText(
  value: unknown,
  path: string,
  ignored: Set<string>,
  allowToolResult = true,
): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (!Array.isArray(value))
    throw invalidRequest(`${path} must be text or content blocks.`, path);
  return value
    .map((part) => {
      if (!isPlainObject(part) || typeof part.type !== 'string') {
        throw invalidRequest(
          `${path} must contain typed content blocks.`,
          path,
        );
      }
      if (['text', 'input_text', 'output_text'].includes(part.type)) {
        if (typeof part.text !== 'string')
          throw invalidRequest(`${path}.text must be a string.`, path);
        for (const key of Object.keys(part)) {
          if (key !== 'type' && key !== 'text') ignored.add(path);
        }
        return part.text;
      }
      if (part.type === 'refusal' && typeof part.refusal === 'string')
        return part.refusal;
      if (part.type === 'tool_result' && allowToolResult) {
        ignored.add(`${path}.tool_result`);
        return compatibilityText(part.content, path, ignored, false);
      }
      // Report the field, not arbitrary caller-controlled type names in a header.
      ignored.add(path);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** The runtime needs a final user turn, unlike the vendor wire contracts. */
export function completeConversation(
  messages: NormalizedMessage[],
  instructions: string | null,
): void {
  if (!messages.length || !messages.some((message) => message.content.trim())) {
    messages.splice(0, messages.length, {
      role: 'user',
      content:
        'No usable text was supplied. Ask the caller to provide text; external references and non-text content were omitted.',
    });
  } else if (messages[messages.length - 1].role === 'assistant') {
    messages.push({
      role: 'user',
      content: 'Continue the preceding assistant response.',
    });
  } else if (!messages[messages.length - 1].content.trim()) {
    messages[messages.length - 1].content =
      'No usable text was supplied in this turn. Ask the caller to provide text.';
  }
  validateConversation(messages, instructions);
}

export function ignoredFields(
  body: Record<string, unknown>,
  supported: readonly string[],
): Set<string> {
  return new Set(
    Object.keys(body).filter(
      (key) =>
        !supported.includes(key) &&
        body[key] !== null &&
        body[key] !== undefined,
    ),
  );
}
