import { Logger } from '@/utils/logger';

import {
  DEFAULT_CONVERSATION_TITLE,
  type Conversation,
  type Message,
} from '@/types/chat';

import { JOB_EXPIRY_SECONDS } from './constants';
import { conversationJobGuardKey } from './conversationJobGuard';
import {
  abortKey,
  acquireFinalization,
  claimTerminalJobStatus,
  clearOAuthStatusFields,
  finalizerLockKey,
  readLiveJobStatusSnapshot,
  releaseFinalizationLock,
  updateFinalizationJournal,
  type FinalizationEffect,
  type FinalizationEvent,
  type FinalizationJournalPhase,
  type FinalizationJournalUpdate,
  type JobFinalizationJournal,
  type NewJobFinalizationJournal,
} from './jobState';
import {
  buildMemoryRetentionSubmission,
  enqueueMemoryRetention,
} from './memoryRetention';
import {
  attachSandboxArtifacts,
  sandboxArtifactsFromSteps,
} from './sandboxArtifacts';
import {
  clearStreamState,
  getStreamResponse,
  getStreamSteps,
  streamResponseKey,
  streamStepsKey,
} from './streamState';
import {
  USER_CANCELLATION_MESSAGE,
  type AsyncJobRequest,
  type AsyncJobStatus,
  type StreamFailureSnapshot,
} from './types';
import { userJobGuardKey } from './userJobGuard';

import {
  ConversationWriteError,
  ConversationWriteFenceError,
  readConversationForUser,
  saveConversationForUser,
} from '@/server/session/conversationStore';
import {
  channels,
  jsonSetWithExpiry,
  streamingStateKey,
} from '@/server/session/redis';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger('AsyncJob');

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
    ...(journal.terminalStatus?.generationDurationMs !== undefined
      ? { generationDurationMs: journal.terminalStatus.generationDurationMs }
      : {}),
    intermediateSteps: finalization.intermediateSteps,
    metadata: {
      ...(finalization.turnId ? { turnId: finalization.turnId } : {}),
      jobId: journal.jobId,
      finalizationId: journal.finalizationId,
      // The browser models Stop as a stopped answer; the worker's record
      // must agree, or the adopted record shows an error and a Retry.
      ...(finalization.stopped ? { stopped: true } : {}),
    },
    ...(finalization.error && !finalization.stopped
      ? {
          errorMessages: {
            message: finalization.error,
            timestamp: journal.finalizedAt,
            recoverable: true,
          },
        }
      : {}),
  };

  return {
    id: finalization.id,
    name: finalization.name,
    folderId: null,
    messages: [...finalization.messages, assistantMessage],
    updatedAt: journal.finalizedAt,
    isPartial: finalization.isPartial,
    ...(finalization.error && !finalization.stopped
      ? { error: finalization.error }
      : {}),
    completedAt: journal.finalizedAt,
  };
}

/**
 * The job owns the turn it appends. Keep the saved folder and any name changed
 * since submission, including when a finalization resumes after saving.
 */
function withSavedMetadata(
  current: Record<string, any> | null,
  conversation: Conversation,
  submittedAt: number | undefined,
): Conversation {
  const result = {
    ...conversation,
    folderId: current?.folderId ?? conversation.folderId,
  };
  const savedName = current?.name;
  if (
    typeof savedName === 'string' &&
    savedName &&
    savedName !== conversation.name &&
    typeof submittedAt === 'number' &&
    Number(current?.updatedAt) > submittedAt
  ) {
    return { ...result, name: savedName };
  }
  return result;
}

async function applyConversationState(
  journal: JobFinalizationJournal,
  conversation: Conversation | null,
  lockToken: string,
): Promise<Conversation | null | false> {
  if (!journal.conversation || !conversation) return conversation;
  let applied = conversation;
  try {
    await saveConversationForUser(
      journal.userId,
      journal.conversation.id,
      (current) => {
        applied = withSavedMetadata(
          current,
          conversation,
          journal.terminalStatus?.createdAt,
        );
        return applied;
      },
      false,
      undefined,
      { key: finalizerLockKey(journal.jobId), token: lockToken },
    );
  } catch (error) {
    if (!(error instanceof ConversationWriteError)) throw error;
    // The user deleted the conversation, or this is a legacy queued job that
    // never owned it. Do not recreate it or publish/retain a saved copy.
    logger.warn(
      `Job ${journal.jobId}: Conversation write suppressed after ownership loss`,
    );
    return false;
  }
  // The selected-conversation pointer holds only an id; a finished turn never
  // changes which conversation is selected, so it is not written here.
  return applied;
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
        generationDurationMs: journal.terminalStatus.generationDurationMs,
        intermediateSteps: journal.conversation.intermediateSteps,
        ...(journal.conversation.error
          ? { error: journal.conversation.error }
          : {}),
      }),
    },
  );
  return events;
}

/**
 * Every remaining phase of a journal, its owner-checked cleanup, its
 * completion events and the memory retention submission, as one write.
 * Planned against the committed journal so a retry records only what it does.
 */
function planCompletion(
  current: JobFinalizationJournal,
  conversation: Conversation | null,
  suppressed: boolean,
): FinalizationJournalUpdate {
  const phases: FinalizationJournalPhase[] = [];
  const effects: FinalizationEffect[] = [];
  let events: FinalizationEvent[] = [];
  const conversationId = current.conversation?.id;
  // The caller applied (or confirmed) the conversation before this write. Its
  // receipt commits before the guards below are released, so a later turn
  // that acquires the guard can never be overwritten by a re-applied journal.
  if (current.conversationAppliedAt === undefined) {
    phases.push('conversationAppliedAt');
  }
  if (suppressed && current.conversationSuppressedAt === undefined) {
    phases.push('conversationSuppressedAt');
  }
  if (current.eventsPublishedAt === undefined) {
    if (current.streamingStateClearedAt === undefined) {
      phases.push('streamingStateClearedAt');
      if (conversationId)
        effects.push({
          kind: 'streaming_state',
          key: streamingStateKey(current.userId, conversationId),
        });
    }
    if (current.streamStateClearedAt === undefined) {
      phases.push('streamStateClearedAt');
      effects.push(
        { kind: 'delete', key: streamResponseKey(current.jobId) },
        { kind: 'delete', key: streamStepsKey(current.jobId) },
      );
    }
    if (current.conversationGuardReleasedAt === undefined) {
      phases.push('conversationGuardReleasedAt');
      effects.push({
        kind: 'user_guard',
        key: userJobGuardKey(current.userId),
      });
      if (conversationId)
        effects.push({
          kind: 'conversation_guard',
          key: conversationJobGuardKey(current.userId, conversationId),
        });
    }
    events = buildFinalizationEvents(current, conversation);
  }
  if (current.memoryRetentionAttemptedAt === undefined) {
    // Journals from earlier versions may already hold an accepted receipt;
    // the caller enqueued its polling before this write.
    const submission =
      !current.memoryRetention &&
      !suppressed &&
      current.outcome === 'completed' &&
      current.conversation
        ? buildMemoryRetentionSubmission({
            jobId: current.jobId,
            userId: current.userId,
            conversationId: current.conversation.id,
            assistantMessageId: current.conversation.assistantMessageId,
            messages: current.conversation.messages,
            content: current.conversation.content,
            createdAt: Date.now(),
          })
        : null;
    if (submission) effects.push({ kind: 'retention', ...submission });
    phases.push('memoryRetentionAttemptedAt');
  }
  phases.push('completedAt');
  return { phases, effects, events };
}

/** Finish a journal whose finalizer lock this caller holds. */
async function completeLockedFinalization(
  initial: JobFinalizationJournal,
  lockToken: string,
): Promise<'completed' | 'pending'> {
  const { jobId } = initial;
  if (initial.state === 'completed' && initial.completedAt) return 'completed';

  let conversation = initial.conversationSuppressedAt
    ? null
    : conversationFromJournal(initial);
  let suppressed = Boolean(initial.conversationSuppressedAt);
  if (!initial.conversationAppliedAt) {
    const applied = await applyConversationState(
      initial,
      conversation,
      lockToken,
    );
    if (applied === false) {
      suppressed = true;
      conversation = null;
    } else {
      conversation = applied;
    }
  } else if (conversation) {
    // The journal keeps the submitted name. A crash after the save must not
    // publish it over a newer rename, or republish a deleted conversation.
    try {
      const current = await readConversationForUser(
        initial.userId,
        conversation.id,
      );
      conversation = current
        ? withSavedMetadata(
            current,
            conversation,
            initial.terminalStatus?.createdAt,
          )
        : null;
    } catch (error) {
      if (!(error instanceof ConversationWriteError)) throw error;
      conversation = null;
    }
    if (!conversation) suppressed = true;
  }

  if (!initial.memoryRetentionAttemptedAt && initial.memoryRetention) {
    try {
      await enqueueMemoryRetention({
        jobId,
        userId: initial.userId,
        operationId: initial.memoryRetention.operationId,
        acceptedAt: initial.memoryRetention.acceptedAt,
      });
    } catch (error) {
      logger.warn(`Job ${jobId}: Automatic memory retention failed`, error);
    }
  }

  // One write records every remaining phase, releases the guards, publishes
  // completion and queues memory retention. Optional retention work never
  // extends the browser's "Generating response" state or holds the slot.
  const journal = await updateFinalizationJournal(
    jobId,
    initial.finalizationId,
    (current) => planCompletion(current, conversation, suppressed),
    Date.now(),
    initial,
  );
  if (!journal) {
    throw new Error(
      `Job ${jobId}: finalization journal changed while completing`,
    );
  }
  return journal.state === 'completed' ? 'completed' : 'pending';
}

async function completeWithLock(
  journal: JobFinalizationJournal,
  lockToken: string,
): Promise<'completed' | 'pending'> {
  try {
    return await completeLockedFinalization(journal, lockToken);
  } catch (error) {
    // Another finalizer may have completed this journal and released its
    // conversation while we were delayed. Let its owner or a retry finish.
    if (error instanceof ConversationWriteFenceError) return 'pending';
    throw error;
  } finally {
    await releaseFinalizationLock(journal.jobId, lockToken).catch(() => {
      // The lock's TTL still bounds a failed release.
    });
  }
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lockToken = uuidv4();
    const acquired = await acquireFinalization(jobId, lockToken);
    if (acquired.state === 'missing') return 'none';
    if (acquired.state === 'completed') return 'completed';
    if (acquired.state === 'locked') {
      return completeWithLock(acquired.journal, lockToken);
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return 'pending';
}

/**
 * Claim the terminal outcome and, when this caller wins, finish the journal it
 * wrote under the lock taken in the same commit. A loser (or a winner whose
 * lock was busy) resumes whatever journal won.
 */
async function claimAndComplete(
  jobId: string,
  updates: Parameters<typeof claimTerminalJobStatus>[1],
  journal: NewJobFinalizationJournal,
  snapshot: string | null,
): Promise<{ claimed: boolean; resumed: FinalizationResumeResult }> {
  const lockToken = uuidv4();
  const claim = await claimTerminalJobStatus(jobId, updates, journal, {
    snapshot,
    lockToken,
  });
  const resumed = claim.lockedJournal
    ? await completeWithLock(claim.lockedJournal, lockToken)
    : await resumePendingFinalization(jobId);
  return { claimed: claim.claimed, resumed };
}

export async function finalizeSuccess(
  jobId: string,
  jobRequest: AsyncJobRequest,
  rawOutput: string,
  observedSteps: any[] = [],
): Promise<boolean> {
  // Independent reads: the steps for the journal and the live status the
  // terminal claim compares.
  const [storedSteps, statusSnapshot] = await Promise.all([
    getStreamSteps(jobId),
    readLiveJobStatusSnapshot(jobId),
  ]);
  // The answer text comes from the reader's memory while the steps are read
  // back from an expiring Redis list. If that list was lost, the reader's own
  // copy of every published step keeps the saved turn complete.
  let accumulatedSteps = storedSteps;
  if (observedSteps.length > storedSteps.length) {
    logger.warn(
      `Job ${jobId}: persisted stream steps are incomplete; finalizing from the reader's copy`,
      { stored: storedSteps.length, observed: observedSteps.length },
    );
    accumulatedSteps = observedSteps;
  }
  const outputWithArtifacts = attachSandboxArtifacts(
    rawOutput,
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

  const responseContent = processedContent.trim()
    ? processedContent
    : '[No response was generated]';
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
            name: jobRequest.conversationName || DEFAULT_CONVERSATION_TITLE,
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

  const { claimed, resumed } = await claimAndComplete(
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
    statusSnapshot,
  );
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
  return true;
}

export async function finalizeError(
  jobId: string,
  jobRequest: AsyncJobRequest,
  errorMessage: string,
  streamSnapshot?: StreamFailureSnapshot,
): Promise<boolean> {
  // The stop signal and the reads are independent; none waits for another.
  const [, statusSnapshot, storedResponse, storedSteps] = await Promise.all([
    jsonSetWithExpiry(abortKey(jobId), true, JOB_EXPIRY_SECONDS).catch(
      () => {},
    ),
    readLiveJobStatusSnapshot(jobId),
    streamSnapshot ? null : getStreamResponse(jobId, ''),
    getStreamSteps(jobId),
  ]);
  const currentStatus = statusSnapshot
    ? (JSON.parse(statusSnapshot) as AsyncJobStatus)
    : null;
  // Jobs from earlier versions kept their output in the status snapshot.
  const partialResponse =
    streamSnapshot?.response ??
    (storedResponse || currentStatus?.partialResponse || '');
  let intermediateSteps = storedSteps.length
    ? storedSteps
    : currentStatus?.intermediateSteps || [];
  if (streamSnapshot?.pendingSteps.length) {
    if (intermediateSteps.length < streamSnapshot.persistedStepCount) {
      throw new Error(
        'Cannot finalize before persisted stream steps are available',
      );
    }
    // A failed append may have committed before its reply was lost. Replace
    // only the unacknowledged suffix instead of duplicating those events.
    intermediateSteps = [
      ...intermediateSteps.slice(0, streamSnapshot.persistedStepCount),
      ...streamSnapshot.pendingSteps,
    ];
  }

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
  // A Stop keeps whatever text had streamed, as the browser's own Stop does.
  const stopped = errorMessage === USER_CANCELLATION_MESSAGE;
  const conversationContent = processedContent.trim()
    ? processedContent
    : stopped
    ? ''
    : '[Error occurred before response was generated]';
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
            name: jobRequest.conversationName || DEFAULT_CONVERSATION_TITLE,
            messages: jobRequest.messages || [],
            assistantMessageId,
            ...(jobRequest.turnId ? { turnId: jobRequest.turnId } : {}),
            content: conversationContent,
            intermediateSteps,
            isPartial: true,
            error: errorMessage,
            ...(stopped ? { stopped: true } : {}),
          },
        }
      : {}),
  };

  const { claimed, resumed } = await claimAndComplete(
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
    statusSnapshot,
  );
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
