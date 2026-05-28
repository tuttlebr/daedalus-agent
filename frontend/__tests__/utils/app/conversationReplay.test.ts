import {
  sanitizeConversationAssistantReplays,
  sanitizeConversationsAssistantReplays,
  stripReplayedAssistantPrefix,
} from '@/utils/app/conversationReplay';

import { describe, expect, it } from 'vitest';

describe('conversation replay sanitization', () => {
  it('strips an exact prior assistant replay plus the new answer', () => {
    const prior =
      'Daily summary for May 13, 2026.\n\n## 1. Date\nCurrent timestamp: 2026-05-13 15:26 UTC.';
    const next = 'The `nemotron-omni` namespace is healthy overall.';

    expect(
      stripReplayedAssistantPrefix(`${prior}\n\n${next}`, [
        { role: 'assistant', content: prior },
      ]),
    ).toBe(next);
  });

  it('strips separator rules between a replayed answer and the new answer', () => {
    const prior = 'Previous answer.';
    const next = 'Current answer.';

    expect(
      stripReplayedAssistantPrefix(`${prior}\n\n---\n\n${next}`, [
        { role: 'assistant', content: prior },
      ]),
    ).toBe(next);
  });

  it('strips a prior assistant replay appended after the new answer', () => {
    const prior = 'Previous answer with enough detail to be replayed later.';
    const next = 'Current answer.';

    expect(
      stripReplayedAssistantPrefix(`${next}\n\n${prior}`, [
        { role: 'assistant', content: prior },
      ]),
    ).toBe(next);
  });

  it('strips leaked internal prompt markers from the start of a response', () => {
    const marker =
      '[Prior assistant response omitted from this backend prompt to prevent replay. ' +
      'Use the surrounding user messages as conversation context. Do not reproduce earlier assistant messages.]';
    const next = 'It first appeared in v1.0.0rc5.';

    expect(stripReplayedAssistantPrefix(`${marker}${next}`, [])).toBe(next);
  });

  it('strips leaked internal prompt markers from the end of a response', () => {
    const marker =
      '[Prior assistant response omitted from this backend prompt to prevent replay. ' +
      'Use the surrounding user messages as conversation context. Do not reproduce earlier assistant messages.]';
    const next = 'It first appeared in v1.0.0rc5.';

    expect(stripReplayedAssistantPrefix(`${next}${marker}`, [])).toBe(next);
  });

  it('strips separator rules before an appended prior assistant replay', () => {
    const prior = 'Previous answer.';
    const next = 'Current answer.';

    expect(
      stripReplayedAssistantPrefix(`${next}\n\n---\n\n${prior}`, [
        { role: 'assistant', content: prior },
      ]),
    ).toBe(next);
  });

  it('preserves responses that reference the prior answer without exact-prefix replay', () => {
    const prior = 'Daily summary for May 13, 2026.';
    const next =
      'Compared with the prior daily summary, the namespace is now healthy.';

    expect(
      stripReplayedAssistantPrefix(next, [
        { role: 'assistant', content: prior },
      ]),
    ).toBe(next);
  });

  it('preserves natural sentence prefixes that are not replay boundaries', () => {
    expect(
      stripReplayedAssistantPrefix('OK, here is the current status.', [
        { role: 'assistant', content: 'OK' },
      ]),
    ).toBe('OK, here is the current status.');
  });

  it('does not blank an assistant message if stripping would leave no content', () => {
    expect(
      stripReplayedAssistantPrefix('Same answer.', [
        { role: 'assistant', content: 'Same answer.' },
      ]),
    ).toBe('Same answer.');
  });

  it('sanitizes repeated assistant content inside a conversation', () => {
    const prior = 'First answer.';
    const next = 'Second answer.';
    const conversation = {
      id: 'conv-1',
      name: 'Test',
      folderId: null,
      messages: [
        { role: 'user' as const, content: 'first' },
        { role: 'assistant' as const, content: prior },
        { role: 'user' as const, content: 'second' },
        { role: 'assistant' as const, content: `${prior}\n\n${next}` },
      ],
    };

    const sanitized = sanitizeConversationAssistantReplays(conversation);

    expect(sanitized).not.toBe(conversation);
    expect(sanitized.messages[3].content).toBe(next);
  });

  it('returns the original conversation objects when no sanitization is needed', () => {
    const conversation = {
      id: 'conv-1',
      name: 'Test',
      folderId: null,
      messages: [
        { role: 'user' as const, content: 'hello' },
        { role: 'assistant' as const, content: 'Hi.' },
      ],
    };

    expect(sanitizeConversationAssistantReplays(conversation)).toBe(
      conversation,
    );
    expect(
      sanitizeConversationsAssistantReplays([conversation]),
    ).toBeInstanceOf(Array);
    expect(sanitizeConversationsAssistantReplays([conversation])[0]).toBe(
      conversation,
    );
  });

  it('fuzzy: strips a prior replay even when the exact join uses different whitespace', () => {
    const prior =
      'The nemotron-omni namespace is healthy. All pods are running and the queue depth is steady.';
    const next =
      'For the next deploy, focus on the auth-proxy memory limits and the new rollout strategy.';

    expect(
      stripReplayedAssistantPrefix(`${prior}    \n  ${next}`, [
        { role: 'assistant', content: prior },
      ]),
    ).toBe(next);
  });

  it('fuzzy: does not strip when the shared prefix is below the word/char threshold', () => {
    const prior = 'OK, sure thing.';
    const next =
      'OK, here is the current status for the namespace today. All pods are running.';

    expect(
      stripReplayedAssistantPrefix(next, [
        { role: 'assistant', content: prior },
      ]),
    ).toBe(next);
  });

  it('fuzzy: does not strip when stripping would leave less than 20 chars (fuzzy path only)', () => {
    // Exact-match path requires literal startsWith; introducing an extra
    // newline inside the prior makes only the fuzzy path eligible.
    const prior =
      'Status update for the morning: every team completed planned work and the release branch is clean.';
    const priorWithDrift = prior.replace(': ', ':\n\n');
    const composite = `${priorWithDrift}\n\nok thx`;

    expect(
      stripReplayedAssistantPrefix(composite, [
        { role: 'assistant', content: prior },
      ]),
    ).toBe(composite);
  });

  it('fuzzy: strips a prior replay appended after the new answer with mild punctuation drift', () => {
    const prior =
      'Daily summary: every team finished their planned work today. The release branch is clean and the rollout is on schedule.';
    const next =
      'New question: which deploys are still pending for tomorrow morning?';

    expect(
      stripReplayedAssistantPrefix(`${next}\n\n${prior}  `, [
        { role: 'assistant', content: prior },
      ]),
    ).toBe(next);
  });

  it('fuzzy: preserves a response that quotes a small fragment of prior content', () => {
    const prior =
      'The deployment uses the auth-proxy sidecar with a 512Mi memory limit on each pod.';
    const next =
      'Yes, the auth-proxy sidecar is the right place to apply the patch this sprint.';

    expect(
      stripReplayedAssistantPrefix(next, [
        { role: 'assistant', content: prior },
      ]),
    ).toBe(next);
  });
});
