import {
  buildBackendBaseUrlForMode,
  buildBackendUrlFromBase,
} from '@/utils/app/backendApi';
import {
  sanitizeConversationAssistantReplays,
  stripReplayedAssistantPrefix,
} from '@/utils/app/conversationReplay';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout';
import { Logger } from '@/utils/logger';

import type { Conversation, Message } from '@/types/chat';

import { JOB_EXPIRY_SECONDS } from './constants';
import { releaseConversationJobGuard } from './conversationJobGuard';
import {
  abortKey,
  claimTerminalJobStatus,
  clearOAuthStatusFields,
  getFinalizationJournal,
  markFinalizationPhase,
  publishFinalizationEvents,
  setMemoryRetentionReceipt,
  withFinalizationLock,
  type FinalizationEvent,
  type JobFinalizationJournal,
  type NewJobFinalizationJournal,
} from './jobState';
import { enqueueMemoryRetention } from './memoryRetention';
import { buildNatRequestHeaders } from './natMessages';
import {
  attachSandboxArtifacts,
  sandboxArtifactsFromSteps,
} from './sandboxArtifacts';
import {
  clearStreamState,
  getStreamResponse,
  getStreamSteps,
} from './streamState';
import type { AsyncJobRequest, AsyncJobStatus } from './types';

import {
  channels,
  clearStreamingState,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger('AsyncJob');
const CONVERSATION_EXPIRY_SECONDS = 60 * 60 * 24 * 7;
const MEMORY_RETAIN_TIMEOUT_MS = 20_000;
const MEMORY_RETAIN_MAX_PART_CHARS = 5_500;

export type FinalizationResumeResult = 'none' | 'pending' | 'completed';

function conversationFromJournal(
  journal: JobFinalizationJournal,
): Conversation | null {
  const finalization = journal.conversation;
  if (!finalization) return null;

  const assistantMessage: Message = {
    id: finalization.assistantMessageId,
    role: 'assistant',
    content: finalization.content,
    intermediateSteps: finalization.intermediateSteps,
    metadata: {
      ...(finalization.turnId ? { turnId: finalization.turnId } : {}),
      jobId: journal.jobId,
      finalizationId: journal.finalizationId,
    },
    ...(finalization.error
      ? {
          errorMessages: {
            message: finalization.error,
            timestamp: journal.finalizedAt,
            recoverable: true,
          },
        }
      : {}),
  };

  return sanitizeConversationAssistantReplays({
    id: finalization.id,
    name: finalization.name,
    folderId: null,
    messages: [...finalization.messages, assistantMessage],
    updatedAt: journal.finalizedAt,
    isPartial: finalization.isPartial,
    ...(finalization.error ? { error: finalization.error } : {}),
    completedAt: journal.finalizedAt,
  });
}

async function applyConversationState(
  journal: JobFinalizationJournal,
  conversation: Conversation | null,
): Promise<void> {
  if (!journal.conversation || !conversation) return;

  await jsonSetWithExpiry(
    sessionKey(['conversation', journal.conversation.id]),
    conversation,
    CONVERSATION_EXPIRY_SECONDS,
  );

  const selectedConversationKey = sessionKey([
    'user',
    journal.userId,
    'selectedConversation',
  ]);
  const selectedConversation = (await jsonGet(
    selectedConversationKey,
  )) as Conversation | null;
  if (selectedConversation?.id === journal.conversation.id) {
    await jsonSetWithExpiry(
      selectedConversationKey,
      sanitizeConversationAssistantReplays({
        ...selectedConversation,
        messages: conversation.messages,
        name: journal.conversation.name,
        updatedAt: journal.finalizedAt,
      }),
      CONVERSATION_EXPIRY_SECONDS,
    );
  }
}

function buildFinalizationEvents(
  journal: JobFinalizationJournal,
  conversation: Conversation | null,
): FinalizationEvent[] {
  if (!journal.terminalStatus) {
    throw new Error(
      `Job ${journal.jobId}: finalization journal has no terminal status`,
    );
  }

  const events: FinalizationEvent[] = [
    {
      channel: `job:${journal.jobId}:status`,
      payload: JSON.stringify(journal.terminalStatus),
    },
  ];
  if (!journal.conversation || !conversation) return events;

  const userUpdatesChannel = channels.userUpdates(journal.userId);
  events.push(
    {
      channel: userUpdatesChannel,
      payload: JSON.stringify({
        type: 'streaming_ended',
        timestamp: journal.finalizedAt,
        data: {
          conversationId: journal.conversation.id,
          sessionId: journal.jobId,
          isStreaming: false,
        },
      }),
    },
    {
      channel: userUpdatesChannel,
      payload: JSON.stringify({
        type: 'conversation_updated',
        timestamp: journal.finalizedAt,
        data: {
          conversationId: journal.conversation.id,
          conversation,
        },
      }),
    },
    {
      channel: `user:${journal.userId}:chat:${journal.conversation.id}:tokens`,
      payload: JSON.stringify({
        type: 'chat_complete',
        conversationId: journal.conversation.id,
        jobId: journal.jobId,
        turnId: journal.conversation.turnId,
        assistantMessageId: journal.conversation.assistantMessageId,
        fullResponse: journal.conversation.content,
        intermediateSteps: journal.conversation.intermediateSteps,
        ...(journal.conversation.error
          ? { error: journal.conversation.error }
          : {}),
      }),
    },
  );
  return events;
}

async function requirePhase(
  journal: JobFinalizationJournal,
  phase:
    | 'conversationAppliedAt'
    | 'memoryRetentionAttemptedAt'
    | 'streamingStateClearedAt'
    | 'streamStateClearedAt'
    | 'conversationGuardReleasedAt'
    | 'completedAt',
): Promise<JobFinalizationJournal> {
  const updated = await markFinalizationPhase(
    journal.jobId,
    journal.finalizationId,
    phase,
    Date.now(),
  );
  if (!updated) {
    throw new Error(
      `Job ${journal.jobId}: finalization journal changed while marking ${phase}`,
    );
  }
  return updated;
}

function latestUserText(journal: JobFinalizationJournal): string {
  const messages = journal.conversation?.messages;
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user' || typeof message?.content !== 'string') {
      continue;
    }
    return message.content.trim();
  }
  return '';
}

function sanitizeRetentionText(value: string): string {
  return value
    .replace(
      /\[(?:IDENTITY|MEMORY_CONTEXT|SOURCE_POLICY)\][\s\S]*?(?=\n\[[A-Z_]+\]|$)/gi,
      '',
    )
    .replace(/data:[^\s)\]]+/gi, '[embedded data omitted]')
    .replace(/redis(?:s)?:\/\/[^\s)\]]+/gi, '[internal reference omitted]')
    .trim()
    .slice(0, MEMORY_RETAIN_MAX_PART_CHARS);
}

async function retainSuccessfulUserTurn(
  journal: JobFinalizationJournal,
): Promise<{ operationId: string; acceptedAt: number } | null> {
  if (journal.outcome !== 'completed' || !journal.conversation) return null;
  const userContent = sanitizeRetentionText(latestUserText(journal));
  const assistantContent = sanitizeRetentionText(journal.conversation.content);
  if (!userContent) return null;

  const url = buildBackendUrlFromBase(
    buildBackendBaseUrlForMode(),
    '/v1/memory/retain-turn',
  );
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: buildNatRequestHeaders(
        journal.userId,
        { 'Content-Type': 'application/json' },
        undefined,
        undefined,
        journal.conversation.id,
        journal.jobId,
      ),
      body: JSON.stringify({
        request_id: journal.jobId,
        conversation_id: journal.conversation.id,
        assistant_message_id: journal.conversation.assistantMessageId,
        user_content: userContent,
        assistant_content: assistantContent,
      }),
    },
    MEMORY_RETAIN_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`memory retention returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as { operation_id?: string };
  if (!body.operation_id) {
    throw new Error('memory retention returned no operation ID');
  }
  return { operationId: body.operation_id, acceptedAt: Date.now() };
}

/**
 * Finish every Redis side effect represented by a terminal journal.
 *
 * Conversation writes and cleanup are deterministic and safe to repeat. The
 * completion publications are emitted by the same Redis script that records
 * eventsPublishedAt, closing the publish-before-marker crash window.
 */
export async function resumePendingFinalization(
  jobId: string,
): Promise<FinalizationResumeResult> {
  const initial = await getFinalizationJournal(jobId);
  if (!initial) return 'none';
  if (initial.state === 'completed' && initial.completedAt) return 'completed';

  const result = await withFinalizationLock(jobId, async () => {
    let journal = await getFinalizationJournal(jobId);
    if (!journal) return 'none' as const;
    if (journal.state === 'completed' && journal.completedAt) {
      return 'completed' as const;
    }

    const conversation = conversationFromJournal(journal);
    if (!journal.conversationAppliedAt) {
      await applyConversationState(journal, conversation);
      journal = await requirePhase(journal, 'conversationAppliedAt');
    }

    if (!journal.streamingStateClearedAt) {
      if (journal.conversation) {
        await clearStreamingState(journal.userId, journal.conversation.id);
      }
      journal = await requirePhase(journal, 'streamingStateClearedAt');
    }

    if (!journal.streamStateClearedAt) {
      await clearStreamState(jobId);
      journal = await requirePhase(journal, 'streamStateClearedAt');
    }

    if (!journal.conversationGuardReleasedAt) {
      if (journal.conversation) {
        await releaseConversationJobGuard(
          journal.userId,
          journal.conversation.id,
          journal.jobId,
        );
      }
      journal = await requirePhase(journal, 'conversationGuardReleasedAt');
    }

    // Everything the browser needs is now durable, and a follow-up turn can
    // safely acquire the conversation guard. Publish completion before optional
    // retention work so a slow or unavailable memory service never extends the
    // UI's "Generating response" state.
    if (!journal.eventsPublishedAt) {
      const updated = await publishFinalizationEvents(
        journal.jobId,
        journal.finalizationId,
        buildFinalizationEvents(journal, conversation),
        Date.now(),
      );
      if (!updated) {
        throw new Error(
          `Job ${jobId}: finalization journal changed while publishing events`,
        );
      }
      journal = updated;
    }

    if (!journal.memoryRetentionAttemptedAt) {
      try {
        let receipt:
          | { operationId: string; acceptedAt: number }
          | null
          | undefined = journal.memoryRetention;
        if (!receipt) {
          receipt = await retainSuccessfulUserTurn(journal);
          if (receipt) {
            const updated = await setMemoryRetentionReceipt(
              journal.jobId,
              journal.finalizationId,
              receipt,
            );
            if (!updated) {
              throw new Error(
                `Job ${jobId}: finalization journal changed while storing memory receipt`,
              );
            }
            journal = updated;
          }
        }
        if (receipt) {
          await enqueueMemoryRetention({
            jobId: journal.jobId,
            userId: journal.userId,
            operationId: receipt.operationId,
            acceptedAt: receipt.acceptedAt,
          });
        }
      } catch (error) {
        // Chat completion remains available when the optional memory service
        // is unhealthy. The failed attempt is observable and is not retried in
        // a tight finalization loop.
        logger.warn(`Job ${jobId}: Automatic memory retention failed`, error);
      }
      journal = await requirePhase(journal, 'memoryRetentionAttemptedAt');
    }

    if (!journal.completedAt) {
      journal = await requirePhase(journal, 'completedAt');
    }
    return journal.state === 'completed'
      ? ('completed' as const)
      : ('pending' as const);
  });

  return result ?? 'pending';
}

async function sendSuccessPushNotification(
  journal: NewJobFinalizationJournal,
): Promise<void> {
  try {
    const webpush = await import('web-push');
    const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
    if (!vapidPublicKey || !vapidPrivateKey || !journal.userId) return;

    webpush.setVapidDetails(
      'mailto:noreply@daedalus.app',
      vapidPublicKey,
      vapidPrivateKey,
    );
    const subscriptions = await jsonGet(
      sessionKey(['user', journal.userId, 'push-subscriptions']),
    );
    if (!Array.isArray(subscriptions) || subscriptions.length === 0) return;

    const payload = JSON.stringify({
      title: 'Response Ready',
      body: 'Your conversation has a new response',
      data: { conversationId: journal.conversation?.id },
    });
    for (const subscription of subscriptions) {
      webpush.sendNotification(subscription, payload).catch((error: any) => {
        logger.warn(`Push notification failed: ${error.statusCode}`);
      });
    }
  } catch (error) {
    logger.debug('Push notification skipped', error);
  }
}

export async function finalizeSuccess(
  jobId: string,
  jobRequest: AsyncJobRequest,
  rawOutput: string,
): Promise<boolean> {
  const accumulatedSteps = await getStreamSteps(jobId);
  const finalOutput = stripReplayedAssistantPrefix(
    rawOutput,
    jobRequest.messages || [],
  );
  const outputWithArtifacts = attachSandboxArtifacts(
    finalOutput,
    sandboxArtifactsFromSteps(accumulatedSteps),
  );
  let processedContent = outputWithArtifacts;
  try {
    const { processMarkdownImages } = await import('@/utils/app/imageHandler');
    processedContent = await processMarkdownImages(outputWithArtifacts, {
      userId: jobRequest.userId,
      sessionId: jobRequest.natSessionId || jobId,
    });
    if (processedContent !== outputWithArtifacts) {
      logger.info(`Job ${jobId}: Replaced base64 images with Redis references`);
    }
  } catch (error) {
    logger.error(`Job ${jobId}: Failed to process images`, error);
  }

  const responseContent =
    (processedContent && processedContent.trim()) ||
    '[No response was generated]';
  const finalizedAt = Date.now();
  const assistantMessageId =
    jobRequest.assistantMessageId ||
    (jobRequest.conversationId ? uuidv4() : undefined);
  const journal: NewJobFinalizationJournal = {
    version: 1,
    state: 'pending',
    jobId,
    finalizationId: uuidv4(),
    outcome: 'completed',
    userId: jobRequest.userId,
    finalizedAt,
    ...(jobRequest.conversationId && assistantMessageId
      ? {
          conversation: {
            id: jobRequest.conversationId,
            name: jobRequest.conversationName || 'New Conversation',
            messages: jobRequest.messages || [],
            assistantMessageId,
            ...(jobRequest.turnId ? { turnId: jobRequest.turnId } : {}),
            content: responseContent,
            intermediateSteps: accumulatedSteps,
            isPartial: false,
          },
        }
      : {}),
  };

  const claimed = await claimTerminalJobStatus(
    jobId,
    {
      status: 'completed',
      fullResponse: responseContent,
      partialResponse: undefined,
      error: undefined,
      ...clearOAuthStatusFields(),
      intermediateSteps: accumulatedSteps,
      progress: 100,
      turnId: jobRequest.turnId,
      assistantMessageId,
      updatedAt: finalizedAt,
      finalizedAt,
    },
    journal,
  );

  const resumed = await resumePendingFinalization(jobId);
  if (!claimed) {
    logger.info(`Job ${jobId}: Success finalizer lost terminal-state race`);
    if (resumed === 'none') await clearStreamState(jobId).catch(() => {});
    return false;
  }
  if (resumed === 'none') {
    throw new Error(`Job ${jobId}: success finalization journal is missing`);
  }
  if (resumed === 'pending') {
    logger.info(
      `Job ${jobId}: Success side effects are owned by another worker`,
    );
    return true;
  }

  logger.info(
    `Job ${jobId}: Finalized successfully (${accumulatedSteps.length} steps)`,
  );
  await sendSuccessPushNotification(journal);
  return true;
}

export async function finalizeError(
  jobId: string,
  jobRequest: AsyncJobRequest,
  errorMessage: string,
): Promise<boolean> {
  await jsonSetWithExpiry(abortKey(jobId), true, JOB_EXPIRY_SECONDS).catch(
    () => {},
  );

  const statusKey = sessionKey(['async-job-status', jobId]);
  const currentStatus = (await jsonGet(statusKey)) as AsyncJobStatus | null;
  const partialResponse = stripReplayedAssistantPrefix(
    await getStreamResponse(jobId, currentStatus?.partialResponse || ''),
    jobRequest.messages || [],
  );
  const intermediateSteps = await getStreamSteps(
    jobId,
    currentStatus?.intermediateSteps || [],
  );

  const responseWithArtifacts = attachSandboxArtifacts(
    partialResponse,
    sandboxArtifactsFromSteps(intermediateSteps),
  );
  let processedContent = responseWithArtifacts;
  if (responseWithArtifacts) {
    try {
      const { processMarkdownImages } = await import(
        '@/utils/app/imageHandler'
      );
      processedContent = await processMarkdownImages(responseWithArtifacts, {
        userId: jobRequest.userId,
        sessionId: jobRequest.natSessionId || jobId,
      });
    } catch {
      // Image processing is non-critical for an error response.
    }
  }

  const finalizedAt = Date.now();
  const assistantMessageId =
    jobRequest.assistantMessageId ||
    (jobRequest.conversationId ? uuidv4() : undefined);
  const conversationContent =
    (processedContent && processedContent.trim()) ||
    '[Error occurred before response was generated]';
  const journal: NewJobFinalizationJournal = {
    version: 1,
    state: 'pending',
    jobId,
    finalizationId: uuidv4(),
    outcome: 'error',
    userId: jobRequest.userId,
    finalizedAt,
    ...(jobRequest.conversationId && assistantMessageId
      ? {
          conversation: {
            id: jobRequest.conversationId,
            name: jobRequest.conversationName || 'New Conversation',
            messages: jobRequest.messages || [],
            assistantMessageId,
            ...(jobRequest.turnId ? { turnId: jobRequest.turnId } : {}),
            content: conversationContent,
            intermediateSteps,
            isPartial: true,
            error: errorMessage,
          },
        }
      : {}),
  };

  const claimed = await claimTerminalJobStatus(
    jobId,
    {
      status: 'error',
      error: errorMessage,
      fullResponse: undefined,
      // Use the image-processed text, matching finalizeSuccess and the
      // conversation record written from this same journal. Storing
      // responseWithArtifacts here would keep inline base64 images in the job
      // status that processMarkdownImages just replaced with Redis references.
      partialResponse: processedContent,
      ...clearOAuthStatusFields(),
      intermediateSteps,
      turnId: jobRequest.turnId,
      assistantMessageId,
      updatedAt: finalizedAt,
      finalizedAt,
    },
    journal,
  );

  const resumed = await resumePendingFinalization(jobId);
  if (!claimed) {
    logger.info(`Job ${jobId}: Error finalizer lost terminal-state race`);
    if (resumed === 'none') await clearStreamState(jobId).catch(() => {});
    return false;
  }
  if (resumed === 'none') {
    throw new Error(`Job ${jobId}: error finalization journal is missing`);
  }
  if (resumed === 'pending') {
    logger.info(`Job ${jobId}: Error side effects are owned by another worker`);
    return true;
  }

  logger.info(
    `Job ${jobId}: Finalized with error: ${errorMessage} (${intermediateSteps.length} steps preserved)`,
  );
  return true;
}
