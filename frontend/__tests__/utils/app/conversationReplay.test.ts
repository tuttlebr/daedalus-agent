import {
  sanitizeConversationAssistantReplays,
  sanitizeConversationsAssistantReplays,
  sanitizeMessageContentFromPriorAssistant,
  stripReplayedAssistantPrefix,
} from '@/utils/app/conversationReplay';

import { describe, expect, it } from 'vitest';

describe('independent-turn content preservation', () => {
  it.each([
    ['Paris.', 'Paris. It is the capital of France.'],
    ['No.', 'No. The precondition has not been met.'],
    ['Previous answer.', 'Previous answer.\n\n---\n\nCurrent answer.'],
    ['Closing paragraph.', 'Revised opening.\n\nClosing paragraph.'],
    ['Same answer.', 'Same answer.'],
    ['OK', 'OK, here is the current status.'],
    [
      'The deployment uses the auth-proxy sidecar with a 512Mi memory limit on each pod.',
      'The deployment uses the auth-proxy sidecar with a 512Mi memory limit on each pod.\n\nAdd this newly requested section to the complete document.',
    ],
    [
      'Every team completed the planned work. The release is ready.',
      'Every team completed the planned work.\n\nThe release is ready.\n\nThis is a requested complete repeat with further explanation.',
    ],
  ])('preserves output sharing prior text: %s', (prior, output) => {
    const messages = [{ role: 'assistant' as const, content: prior }];
    expect(stripReplayedAssistantPrefix(output, messages)).toBe(output);
    expect(sanitizeMessageContentFromPriorAssistant(output, messages)).toBe(
      output,
    );
  });
  it('does not mutate stored repeated or revised answers on load/save', () => {
    const conversation = {
      id: 'conv-1',
      messages: [
        { role: 'assistant' as const, content: 'First answer.' },
        { role: 'user' as const, content: 'Repeat it, then add more.' },
        {
          role: 'assistant' as const,
          content: 'First answer.\n\nMore detail.',
        },
      ],
    };
    const conversations = [conversation];
    expect(sanitizeConversationAssistantReplays(conversation)).toBe(
      conversation,
    );
    expect(sanitizeConversationsAssistantReplays(conversations)).toBe(
      conversations,
    );
    expect(conversation.messages[2].content).toBe(
      'First answer.\n\nMore detail.',
    );
  });
});
