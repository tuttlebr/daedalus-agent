// One definition of a usable conversation ID for chat submission, backend
// workspace scoping and realtime subscriptions. It is the backend's run
// identity alphabet (ASCII letters, digits, `.`, `_`, `:` and `-`, at most 128
// characters) with an alphanumeric first character, so no ID is a dot segment
// or option-like value. Generated UUIDs always match. This module has no
// imports so the standalone WebSocket bundle can share it.
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const INVALID_CONVERSATION_ID_MESSAGE =
  'Invalid conversation ID. Use 1-128 letters, digits, ".", "_", ":" or "-", starting with a letter or digit.';

export function isValidConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID_PATTERN.test(value);
}
