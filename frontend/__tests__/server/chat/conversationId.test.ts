import { isValidConversationId } from '@/server/chat/conversationId';
import { buildNatRequestHeaders } from '@/server/chat/natMessages';
import { describe, expect, it } from 'vitest';

describe('shared conversation ID rule', () => {
  it.each([
    '3f2b8c1e-7a4d-4e6f-9b1a-2c3d4e5f6a7b',
    'conv-1',
    'imported:conv.1_a',
    'a'.repeat(128),
  ])('accepts %s', (id) => {
    expect(isValidConversationId(id)).toBe(true);
    // Every accepted conversation is also scoped by the backend.
    expect(
      buildNatRequestHeaders('testuser', {}, undefined, undefined, id)[
        'x-conversation-id'
      ],
    ).toBe(id);
  });

  it.each([
    '',
    'a'.repeat(129),
    '-leading',
    '.hidden',
    '_private',
    'not/a/scope',
    'space id',
    'unicode-é',
    undefined,
    42,
  ])('rejects %j', (id) => {
    expect(isValidConversationId(id)).toBe(false);
  });
});
