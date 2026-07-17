import {
  sanitizeConversationAssistantReplays,
  stripReplayedAssistantPrefix,
} from '@/utils/app/conversationReplay';
import { Logger } from '@/utils/logger';
import {
  publishConversationUpdate,
  publishStreamingState,
} from '@/utils/sync/publish';

import { Message } from '@/types/chat';

import { JOB_EXPIRY_SECONDS } from './constants';
import { abortKey, clearOAuthStatusFields, updateJobStatus } from './jobState';
import type { AsyncJobRequest, AsyncJobStatus } from './types';

import {
  clearStreamingState,
  getPublisher,
  jsonDel,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger('AsyncJob');

export async function finalizeSuccess(
  jobId: string,
  jobRequest: AsyncJobRequest,
  rawOutput: string,
): Promise<void> {
  const userId = jobRequest.userId;

  // Retrieve intermediate steps accumulated by the background stream reader
  const stepsKey = sessionKey(['async-job-steps', jobId]);
  const accumulatedSteps = ((await jsonGet(stepsKey)) as any[] | null) || [];

  // Process base64 images in the response
  const finalOutput = stripReplayedAssistantPrefix(
    rawOutput,
    jobRequest.messages || [],
  );
  let processedContent = finalOutput;
  try {
    const { processMarkdownImages } = await import('@/utils/app/imageHandler');
    processedContent = await processMarkdownImages(finalOutput, {
      userId,
      sessionId: jobRequest.natSessionId || jobId,
    });
    if (processedContent !== finalOutput) {
      logger.info(`Job ${jobId}: Replaced base64 images with Redis references`);
    }
  } catch (error) {
    logger.error(`Job ${jobId}: Failed to process images`, error);
  }

  // Save conversation to Redis
  if (jobRequest.conversationId) {
    try {
      const conversationName =
        jobRequest.conversationName || 'New Conversation';
      const assistantMessage: Message = {
        id: jobRequest.assistantMessageId || uuidv4(),
        role: 'assistant',
        content:
          (processedContent && processedContent.trim()) ||
          '[No response was generated]',
        intermediateSteps: accumulatedSteps,
        metadata: {
          ...(jobRequest.turnId ? { turnId: jobRequest.turnId } : {}),
          jobId,
        },
      };
      const allMessages = [...(jobRequest.messages || []), assistantMessage];
      const conversationData = sanitizeConversationAssistantReplays({
        id: jobRequest.conversationId,
        name: conversationName,
        folderId: null,
        messages: allMessages,
        updatedAt: Date.now(),
        isPartial: false,
        completedAt: Date.now(),
      });

      const conversationKey = sessionKey([
        'conversation',
        jobRequest.conversationId,
      ]);
      await jsonSetWithExpiry(
        conversationKey,
        conversationData,
        60 * 60 * 24 * 7,
      );

      // Update selected conversation if it matches
      const selectedConvKey = sessionKey([
        'user',
        userId,
        'selectedConversation',
      ]);
      const selectedConv = (await jsonGet(selectedConvKey)) as any;
      if (selectedConv?.id === jobRequest.conversationId) {
        await jsonSetWithExpiry(
          selectedConvKey,
          sanitizeConversationAssistantReplays({
            ...selectedConv,
            messages: conversationData.messages,
            name: conversationName,
            updatedAt: Date.now(),
          }),
          60 * 60 * 24 * 7,
        );
        logger.info(
          `Job ${jobId}: Updated selected conversation for user ${userId}`,
        );
      }

      logger.info(
        `Job ${jobId}: Saved conversation ${jobRequest.conversationId} with ${conversationData.messages.length} messages (${accumulatedSteps.length} steps)`,
      );

      // Clear streaming state and publish WS events
      await clearStreamingState(userId, jobRequest.conversationId);
      await publishStreamingState(
        userId,
        jobRequest.conversationId,
        false,
        jobId,
      );
      await publishConversationUpdate(userId, conversationData);

      // Publish chat_complete for WS streaming
      const tokenChannel = `user:${userId}:chat:${jobRequest.conversationId}:tokens`;
      getPublisher()
        .publish(
          tokenChannel,
          JSON.stringify({
            type: 'chat_complete',
            conversationId: jobRequest.conversationId,
            jobId,
            turnId: jobRequest.turnId,
            assistantMessageId: assistantMessage.id,
            fullResponse: processedContent,
            intermediateSteps: accumulatedSteps,
          }),
        )
        .catch(() => {});
    } catch (error) {
      logger.error(`Job ${jobId}: Failed to save conversation`, error);
      // Clear streaming state even on error
      if (jobRequest.conversationId) {
        await clearStreamingState(userId, jobRequest.conversationId).catch(
          () => {},
        );
        await publishStreamingState(
          userId,
          jobRequest.conversationId,
          false,
          jobId,
        ).catch(() => {});
      }
    }
  }

  // Update job status to completed
  await updateJobStatus(jobId, {
    status: 'completed',
    fullResponse: processedContent,
    partialResponse: undefined,
    ...clearOAuthStatusFields(),
    intermediateSteps: accumulatedSteps,
    progress: 100,
    turnId: jobRequest.turnId,
    assistantMessageId: jobRequest.assistantMessageId,
    updatedAt: Date.now(),
    finalizedAt: Date.now(),
  });

  // Clean up steps key
  await jsonDel(stepsKey).catch(() => {});

  logger.info(
    `Job ${jobId}: Finalized successfully (${accumulatedSteps.length} steps)`,
  );

  // Send push notification
  try {
    const webpush = await import('web-push');
    const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
    if (vapidPublicKey && vapidPrivateKey && userId) {
      webpush.setVapidDetails(
        'mailto:noreply@daedalus.app',
        vapidPublicKey,
        vapidPrivateKey,
      );
      const subsKey = sessionKey(['user', userId, 'push-subscriptions']);
      const subscriptions = await jsonGet(subsKey);
      if (Array.isArray(subscriptions) && subscriptions.length > 0) {
        const payload = JSON.stringify({
          title: 'Response Ready',
          body: 'Your conversation has a new response',
          data: { conversationId: jobRequest.conversationId },
        });
        for (const sub of subscriptions) {
          webpush.sendNotification(sub, payload).catch((err: any) => {
            logger.warn(`Push notification failed: ${err.statusCode}`);
          });
        }
      }
    }
  } catch (pushError) {
    logger.debug('Push notification skipped', pushError);
  }
}

export async function finalizeError(
  jobId: string,
  jobRequest: AsyncJobRequest,
  errorMessage: string,
): Promise<void> {
  // Signal the stream reader to stop (mirrors the abort set in handleGet for
  // error paths that bypass handleGet's abort logic, e.g. direct calls).
  await jsonSetWithExpiry(abortKey(jobId), true, JOB_EXPIRY_SECONDS).catch(
    () => {},
  );

  const userId = jobRequest.userId;

  // Read current job status to preserve any partial progress accumulated during polling
  const statusKey = sessionKey(['async-job-status', jobId]);
  const currentStatus = (await jsonGet(statusKey)) as AsyncJobStatus | null;
  const partialResponse = stripReplayedAssistantPrefix(
    currentStatus?.partialResponse || '',
    jobRequest.messages || [],
  );

  // Prefer steps from the background stream reader (stored separately),
  // fall back to whatever the job status already has
  const stepsKey = sessionKey(['async-job-steps', jobId]);
  const streamSteps = (await jsonGet(stepsKey)) as any[] | null;
  const intermediateSteps = streamSteps?.length
    ? streamSteps
    : currentStatus?.intermediateSteps || [];

  // Save partial conversation to Redis so progress survives page refresh
  if (jobRequest.conversationId) {
    try {
      const conversationName =
        jobRequest.conversationName || 'New Conversation';
      let processedContent = partialResponse;
      if (partialResponse) {
        try {
          const { processMarkdownImages } = await import(
            '@/utils/app/imageHandler'
          );
          processedContent = await processMarkdownImages(partialResponse, {
            userId,
            sessionId: jobRequest.natSessionId || jobId,
          });
        } catch {
          // Image processing failure is non-critical for error path
        }
      }

      const assistantMessage: Message = {
        id: jobRequest.assistantMessageId || uuidv4(),
        role: 'assistant',
        content:
          (processedContent && processedContent.trim()) ||
          '[Error occurred before response was generated]',
        intermediateSteps,
        metadata: {
          ...(jobRequest.turnId ? { turnId: jobRequest.turnId } : {}),
          jobId,
        },
        errorMessages: {
          message: errorMessage,
          timestamp: Date.now(),
          recoverable: true,
        },
      };
      const allMessages = [...(jobRequest.messages || []), assistantMessage];
      const conversationData = sanitizeConversationAssistantReplays({
        id: jobRequest.conversationId,
        name: conversationName,
        folderId: null,
        messages: allMessages,
        updatedAt: Date.now(),
        isPartial: true,
        error: errorMessage,
        completedAt: Date.now(),
      });

      const conversationKey = sessionKey([
        'conversation',
        jobRequest.conversationId,
      ]);
      await jsonSetWithExpiry(
        conversationKey,
        conversationData,
        60 * 60 * 24 * 7,
      );

      // Update selected conversation if it matches
      const selectedConvKey = sessionKey([
        'user',
        userId,
        'selectedConversation',
      ]);
      const selectedConv = (await jsonGet(selectedConvKey)) as any;
      if (selectedConv?.id === jobRequest.conversationId) {
        await jsonSetWithExpiry(
          selectedConvKey,
          sanitizeConversationAssistantReplays({
            ...selectedConv,
            messages: conversationData.messages,
            name: conversationName,
            updatedAt: Date.now(),
          }),
          60 * 60 * 24 * 7,
        );
      }

      logger.info(
        `Job ${jobId}: Saved partial conversation ${
          jobRequest.conversationId
        } (${
          partialResponse ? partialResponse.length + ' chars' : 'no content'
        }, ${intermediateSteps.length} steps) with error`,
      );

      await clearStreamingState(userId, jobRequest.conversationId).catch(
        () => {},
      );
      await publishStreamingState(
        userId,
        jobRequest.conversationId,
        false,
        jobId,
      ).catch(() => {});
      await publishConversationUpdate(userId, conversationData).catch(() => {});

      // Publish chat_complete with error context so WS clients render partial results
      const tokenChannel = `user:${userId}:chat:${jobRequest.conversationId}:tokens`;
      getPublisher()
        .publish(
          tokenChannel,
          JSON.stringify({
            type: 'chat_complete',
            conversationId: jobRequest.conversationId,
            jobId,
            turnId: jobRequest.turnId,
            assistantMessageId: assistantMessage.id,
            fullResponse: processedContent,
            intermediateSteps,
            error: errorMessage,
          }),
        )
        .catch(() => {});
    } catch (saveError) {
      logger.error(
        `Job ${jobId}: Failed to save partial conversation on error`,
        saveError,
      );
      // Still clear streaming state even if save fails
      await clearStreamingState(userId, jobRequest.conversationId).catch(
        () => {},
      );
      await publishStreamingState(
        userId,
        jobRequest.conversationId,
        false,
        jobId,
      ).catch(() => {});
    }
  }

  await updateJobStatus(jobId, {
    status: 'error',
    error: errorMessage,
    partialResponse,
    ...clearOAuthStatusFields(),
    intermediateSteps,
    turnId: jobRequest.turnId,
    assistantMessageId: jobRequest.assistantMessageId,
    updatedAt: Date.now(),
    finalizedAt: Date.now(),
  });

  // Clean up steps key
  await jsonDel(stepsKey).catch(() => {});

  logger.info(
    `Job ${jobId}: Finalized with error: ${errorMessage} (${intermediateSteps.length} steps preserved)`,
  );
}
