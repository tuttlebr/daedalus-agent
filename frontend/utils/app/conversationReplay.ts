import { Message } from '@/types/chat';

/**
 * Compatibility entry points for callers that previously applied text-based
 * replay stripping. Similarity to another turn cannot establish a duplicate:
 * repeat requests, quotations and revised documents legitimately share text.
 * Transport replay is handled using job identity and offsets in stream state.
 * Never rewrite authoritative model output or stored conversations here.
 */
export function stripReplayedAssistantPrefix(
  rawOutput: string,
  _priorMessages: any[] = [],
): string {
  return rawOutput;
}
export function sanitizeConversationAssistantReplays<
  T extends { messages?: Message[] },
>(conversation: T): T {
  return conversation;
}
export function sanitizeConversationsAssistantReplays<
  T extends { messages?: Message[] },
>(conversations: T[]): T[] {
  return conversations;
}
export function sanitizeMessageContentFromPriorAssistant(
  content: string,
  _priorMessages: Message[] = [],
): string {
  return content;
}
