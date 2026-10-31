import {
  formatMcpApprovalResult,
  parseMcpApprovalMarker,
  type McpApprovalResult,
} from '@/utils/app/mcpApproval';
import { publishConversationUpdate } from '@/utils/sync/publish';

import type { Message } from '@/types/chat';

import type { McpApprovalPreview } from './mcpApproval';

import {
  ConversationWriteError,
  saveConversationForUser,
} from '@/server/session/conversationStore';
import { randomUUID } from 'node:crypto';

/** Replace only this gate, preserving later turns and edits made during execution. */
export async function saveMcpApprovalResult(input: {
  userId: string;
  conversationId: string;
  requestId: string;
  approval: McpApprovalPreview;
  result?: McpApprovalResult;
}): Promise<boolean> {
  let found = false;
  let conversation;
  try {
    conversation = await saveConversationForUser(
      input.userId,
      input.conversationId,
      (current) => {
        found = false;
        let changed = false;
        const messages = (current?.messages || []).map((message: Message) => {
          if (message.metadata?.mcpApprovalRequestId === input.requestId) {
            found = true;
            return message;
          }
          if (
            message.role !== 'assistant' ||
            parseMcpApprovalMarker(message.content)?.requestId !==
              input.requestId
          )
            return message;
          found = changed = true;
          return {
            ...message,
            content: formatMcpApprovalResult(input.approval, input.result),
            metadata: {
              ...message.metadata,
              mcpApprovalRequestId: input.requestId,
            },
          };
        });
        return changed
          ? {
              ...current,
              messages,
              updatedAt: Date.now(),
              revision: randomUUID(),
            }
          : current!;
      },
    );
  } catch (error) {
    // Deletion or ownership loss must never resurrect the conversation.
    if (error instanceof ConversationWriteError && error.reason === 'forbidden')
      return true;
    throw error;
  }
  if (!found) return false; // The original turn may still be finalizing.
  await publishConversationUpdate(
    input.userId,
    input.conversationId,
    conversation.revision,
  );
  return true;
}
