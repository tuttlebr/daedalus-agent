'use client';

import {
  IconArrowDown,
  IconCheck,
  IconExternalLink,
  IconMenu2,
  IconPlus,
  IconRobot,
} from '@tabler/icons-react';
import React, { memo, useCallback, useRef, useEffect, useState } from 'react';
import toast from 'react-hot-toast';

import { useAsyncChat } from '@/hooks/useAsyncChat';

import { getWebSocketManager } from '@/services/websocket';

import { apiGet } from '@/utils/app/api';
import { cleanConversationHistory } from '@/utils/app/clean';
import {
  persistSelectedConversation,
  saveConversation,
  type ConversationChange,
} from '@/utils/app/conversation';
import { buildMessageError } from '@/utils/app/errorCategory';
import { cleanMessagesForLLM } from '@/utils/app/imageHandler';
import {
  getFriendlyName,
  mergeIntermediateStepSnapshot,
} from '@/utils/app/intermediateSteps';
import {
  OAuthPrompt,
  oauthPromptConversationKeyPrefix,
  oauthPromptKey,
  oauthPromptsFromStatus,
  withoutOAuthPromptsForConversation,
} from '@/utils/app/oauthPrompts';
import {
  isStaleCumulativeSnapshot,
  reduceStreamingUpdates,
  type BufferedStreamingUpdate,
} from '@/utils/app/streamingBuffer';

import {
  Conversation,
  DEFAULT_CONVERSATION_TITLE,
  Message,
} from '@/types/chat';
import { IntermediateStep } from '@/types/intermediateSteps';

import { useAuth } from '@/components/auth';
import { IconButton } from '@/components/primitives';

import { ChatInput } from './ChatInput';
import { DocumentIngestProgress } from './DocumentIngestProgress';
import { MessageBubble } from './MessageBubble';

import { branding } from '@/generated/branding';
import { useConversationStore, useUISettingsStore } from '@/state';
import { v4 as uuidv4 } from 'uuid';

const INITIAL_VISIBLE_MESSAGES = 80;
const LOAD_OLDER_MESSAGES_STEP = 40;
const OAUTH_SUCCESS_VISIBLE_MS = 3000;
const AT_BOTTOM_THRESHOLD_PX = 32;
// Each flush re-renders the streaming answer. ResponseDocument re-parses only
// its last Markdown block, but every flush still reconciles the message and
// its activity. 120ms reads identically for streamed text and bounds that
// work. The throttle is leading-edge: the first update after an idle interval
// (the first token, or text after a tool call) renders on the next task
// instead of waiting.
const STREAM_RENDER_INTERVAL_MS = 120;
// A copy that lacks a live job's assistant message predates that turn (for
// example another tab or device started it). Reload it from the server at
// most this often while the job streams.
const CONVERSATION_RESYNC_INTERVAL_MS = 5_000;

type OAuthPromptState = OAuthPrompt & {
  opened?: boolean;
  succeeded?: boolean;
};

interface PendingStreamingBatch {
  conversationId: string;
  assistantMessageId?: string;
  updates: BufferedStreamingUpdate[];
  intermediateSteps?: IntermediateStep[];
}

/**
 * Find the assistant message a job writes to. A job that names its message
 * never falls back to another one: a copy without that message predates the
 * turn, and its latest assistant message is an earlier answer.
 */
function findAssistantMessage(
  messages: Message[],
  assistantMessageId?: string,
): Message | null {
  if (assistantMessageId) {
    const byId = messages.find((message) => message.id === assistantMessageId);
    return byId && byId.role !== 'user' ? byId : null;
  }

  // Legacy jobs carry no message ID; their turn is the latest one.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== 'user') {
      return messages[i];
    }
  }

  return null;
}

function newConversation(): Conversation {
  return {
    id: uuidv4(),
    name: DEFAULT_CONVERSATION_TITLE,
    messages: [],
    folderId: null,
    updatedAt: Date.now(),
  };
}

function getCompactActivityText(step: IntermediateStep): string {
  try {
    return getFriendlyName(step) || 'Working';
  } catch {
    return 'Working';
  }
}

function isSameOAuthServicePrompt(
  left: OAuthPromptState,
  right: OAuthPromptState,
): boolean {
  return (
    left.conversationId === right.conversationId &&
    (!left.jobId || !right.jobId || left.jobId === right.jobId) &&
    (left.service || 'Google') === (right.service || 'Google')
  );
}

export const ChatView = memo(() => {
  const { user } = useAuth();
  const userId = user?.username || 'anon';

  // Store state
  const selectedConversationId = useConversationStore(
    (s) => s.selectedConversationId,
  );
  const selectedConversation = useConversationStore((s) => {
    const id = s.selectedConversationId;
    return id ? s.conversations.find((c) => c.id === id) ?? null : null;
  });
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const addMessage = useConversationStore((s) => s.addMessage);
  const updateMessage = useConversationStore((s) => s.updateMessage);
  const updateLastMessage = useConversationStore((s) => s.updateLastMessage);
  const setStreaming = useConversationStore((s) => s.setStreaming);

  useEffect(
    () =>
      getWebSocketManager().on('steering_status', (event: any) => {
        if (
          !event?.conversationId ||
          typeof event.instruction !== 'string' ||
          typeof event.commandId !== 'string'
        )
          return;
        const conversation = useConversationStore
          .getState()
          .conversations.find((item) => item.id === event.conversationId);
        if (!conversation) return;
        const messages = [...conversation.messages];
        const existing = messages.findIndex(
          (message) => message.id === event.commandId,
        );
        const direction: Message = {
          id: event.commandId,
          role: 'user',
          content: event.instruction,
          metadata: {
            steeringCommandId: event.commandId,
            steeringStatus: event.status,
            jobId: event.jobId,
          },
        };
        if (existing >= 0) messages[existing] = direction;
        else {
          const assistant = messages.findIndex(
            (message) => message.id === event.assistantMessageId,
          );
          messages.splice(
            assistant < 0 ? messages.length : assistant,
            0,
            direction,
          );
        }
        updateConversation(conversation.id, { messages });
      }),
    [updateConversation],
  );

  const toggleChatbar = useUISettingsStore((s) => s.toggleChatbar);
  const setShowChatbar = useUISettingsStore((s) => s.setShowChatbar);
  const enableIntermediateSteps = useUISettingsStore(
    (s) => s.enableIntermediateSteps,
  );

  // Background runs keep their own activity when the user switches chats.
  const [activityByConversation, setActivityByConversation] = useState<
    Record<
      string,
      {
        text?: string;
        announcement?: string;
      }
    >
  >({});
  // Tokens report the same activity on every delivery. Keep the state object
  // when nothing changed so they do not re-render the view between flushes.
  const setActivityText = useCallback((convId: string, text: string) => {
    setActivityByConversation((current) =>
      current[convId]?.text === text
        ? current
        : { ...current, [convId]: { ...current[convId], text } },
    );
  }, []);
  const setStreamAnnouncement = useCallback(
    (convId: string, announcement: string) => {
      setActivityByConversation((current) =>
        current[convId]?.announcement === announcement
          ? current
          : { ...current, [convId]: { ...current[convId], announcement } },
      );
    },
    [],
  );
  const selectedActivity = selectedConversationId
    ? activityByConversation[selectedConversationId]
    : undefined;
  const activityText = selectedActivity?.text || '';
  const streamAnnouncement = selectedActivity?.announcement || '';
  const [oauthPrompts, setOauthPrompts] = useState<OAuthPromptState[]>([]);
  const [visibleMessageCount, setVisibleMessageCount] = useState(
    INITIAL_VISIBLE_MESSAGES,
  );
  const openedOAuthPromptKeysRef = useRef<Set<string>>(new Set());
  const succeededOAuthPromptKeysRef = useRef<Set<string>>(new Set());
  const oauthSuccessTimersRef = useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});
  const streamingIds = useConversationStore((s) => s.streamingConversationIds);
  const isStreaming = selectedConversationId
    ? streamingIds.has(selectedConversationId)
    : false;
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;

  // Refs for async callbacks
  const selectedIdRef = useRef(selectedConversationId);
  selectedIdRef.current = selectedConversationId;

  // Streaming follows by default, but the first explicit upward gesture pauses
  // it immediately. Content growth never gets to reinterpret reading intent.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const isFollowingRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  const pendingStreamingUpdatesRef = useRef<Map<string, PendingStreamingBatch>>(
    new Map(),
  );
  const lastStreamFlushAtRef = useRef(0);
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const pauseFollowing = useCallback(() => {
    if (!isStreamingRef.current || !isFollowingRef.current) return;
    isFollowingRef.current = false;
    setShowScrollToBottom(true);
  }, []);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const movedUp = container.scrollTop < lastScrollTopRef.current - 1;
    if (movedUp) pauseFollowing();
    lastScrollTopRef.current = container.scrollTop;
    const atBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <=
      AT_BOTTOM_THRESHOLD_PX;
    setShowScrollToBottom(
      isStreamingRef.current ? !isFollowingRef.current : !atBottom,
    );
  }, [pauseFollowing]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    isFollowingRef.current = true;
    setShowScrollToBottom(false);
    const container = scrollContainerRef.current;
    // scrollIntoView can scroll every ancestor, including WebKit's document
    // viewport while the keyboard is open. Only move the message pane.
    container?.scrollTo({ top: container.scrollHeight, behavior });
  }, []);

  const jumpToLatest = useCallback(() => {
    const reducedMotion = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    scrollToBottom(reducedMotion ? 'auto' : 'smooth');
  }, [scrollToBottom]);

  const scrollToBottomSoon = useCallback(() => {
    if (!isFollowingRef.current) return;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const container = scrollContainerRef.current;
      if (container && isFollowingRef.current) {
        container.scrollTop = container.scrollHeight;
        lastScrollTopRef.current = container.scrollTop;
      }
    });
  }, []);

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (event.deltaY < 0) pauseFollowing();
    },
    [pauseFollowing],
  );

  const handleTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      touchStartYRef.current = event.touches[0]?.clientY ?? null;
    },
    [],
  );

  const handleTouchMove = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const startY = touchStartYRef.current;
      const currentY = event.touches[0]?.clientY;
      if (startY !== null && currentY !== undefined && currentY > startY + 4) {
        pauseFollowing();
      }
    },
    [pauseFollowing],
  );

  const handleScrollKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pauseFollowing();
    },
    [pauseFollowing],
  );

  const clearOAuthPromptTimer = useCallback((key: string) => {
    const timer = oauthSuccessTimersRef.current[key];
    if (timer) {
      clearTimeout(timer);
      delete oauthSuccessTimersRef.current[key];
    }
  }, []);

  const clearOpenedOAuthPromptsForConversation = useCallback(
    (conversationId: string) => {
      const prefix = oauthPromptConversationKeyPrefix(conversationId);
      for (const key of Array.from(openedOAuthPromptKeysRef.current)) {
        if (key.startsWith(prefix)) {
          openedOAuthPromptKeysRef.current.delete(key);
          clearOAuthPromptTimer(key);
        }
      }
      for (const key of Array.from(succeededOAuthPromptKeysRef.current)) {
        if (key.startsWith(prefix)) {
          succeededOAuthPromptKeysRef.current.delete(key);
        }
      }
    },
    [clearOAuthPromptTimer],
  );

  const removeOAuthPromptByKey = useCallback(
    (key: string) => {
      clearOAuthPromptTimer(key);
      openedOAuthPromptKeysRef.current.delete(key);
      setOauthPrompts((current) =>
        current.filter((prompt) => oauthPromptKey(prompt) !== key),
      );
    },
    [clearOAuthPromptTimer],
  );

  const scheduleOAuthPromptSuccessRemoval = useCallback(
    (key: string) => {
      clearOAuthPromptTimer(key);
      oauthSuccessTimersRef.current[key] = setTimeout(() => {
        removeOAuthPromptByKey(key);
      }, OAUTH_SUCCESS_VISIBLE_MS);
    },
    [clearOAuthPromptTimer, removeOAuthPromptByKey],
  );

  const finishOAuthPromptsForJob = useCallback(
    (
      conversationId: string,
      jobId: string | undefined,
      succeeded: boolean,
      keepUnopened = false,
    ) => {
      setOauthPrompts((current) => {
        // This runs on every streamed token. Returning a new array when nothing
        // changed would re-render the whole chat view per token and defeat the
        // STREAM_RENDER_INTERVAL_MS batching.
        if (current.length === 0) return current;

        let changed = false;
        const next = current.flatMap((prompt) => {
          if (prompt.conversationId !== conversationId) return [prompt];
          if (jobId && prompt.jobId && prompt.jobId !== jobId) return [prompt];
          if (succeeded && prompt.opened) {
            succeededOAuthPromptKeysRef.current.add(oauthPromptKey(prompt));
            if (!prompt.succeeded) {
              scheduleOAuthPromptSuccessRemoval(oauthPromptKey(prompt));
              changed = true;
              return [{ ...prompt, succeeded: true }];
            }
            return [prompt];
          }
          if (keepUnopened) return [prompt];
          changed = true;
          return [];
        });
        return changed ? next : current;
      });
    },
    [scheduleOAuthPromptSuccessRemoval],
  );

  const handleOAuthPromptClick = useCallback(
    (prompt: OAuthPromptState) => {
      window.open(prompt.authUrl, '_blank', 'noopener,noreferrer');
      const key = oauthPromptKey(prompt);
      openedOAuthPromptKeysRef.current.add(key);
      clearOAuthPromptTimer(key);
      setOauthPrompts((current) =>
        current.map((candidate) =>
          oauthPromptKey(candidate) === key
            ? { ...candidate, opened: true, succeeded: false }
            : candidate,
        ),
      );
    },
    [clearOAuthPromptTimer],
  );

  const resyncAttemptsRef = useRef<Map<string, number>>(new Map());
  const resyncingConversationsRef = useRef<Set<string>>(new Set());

  /**
   * Replace a copy that predates a job's turn with the server's record.
   * `finished` jobs have already persisted their answer there.
   */
  const resyncConversation = useCallback(
    (convId: string, assistantMessageId: string, finished = false) => {
      const key = `${convId}\n${assistantMessageId}`;
      const now = Date.now();
      const lastAttempt = resyncAttemptsRef.current.get(key);
      if (
        resyncingConversationsRef.current.has(convId) ||
        (!finished &&
          lastAttempt !== undefined &&
          now - lastAttempt < CONVERSATION_RESYNC_INTERVAL_MS)
      ) {
        return;
      }
      resyncAttemptsRef.current.set(key, now);
      resyncingConversationsRef.current.add(convId);
      void apiGet<Conversation>(
        `/api/conversations/${encodeURIComponent(convId)}`,
      )
        .then((server) => {
          if (!server || !Array.isArray(server.messages)) return;
          const store = useConversationStore.getState();
          const local = store.conversations.find((c) => c.id === convId);
          if (!local) return;
          if (local.messages.some((m) => m.id === assistantMessageId)) return;
          const hasJobMessage = server.messages.some(
            (message) => message.id === assistantMessageId,
          );
          // A running job's copy is only useful once it holds the job's
          // message. After completion the server record is authoritative,
          // unless this tab has meanwhile started another turn there.
          if (
            finished
              ? store.streamingConversationIds.has(convId)
              : !hasJobMessage
          ) {
            return;
          }
          const [conversation] = cleanConversationHistory([
            { ...server, id: convId },
          ]);
          store.addConversation(conversation);
        })
        .catch((error) => {
          console.warn('Failed to reload conversation', error);
        })
        .finally(() => {
          resyncingConversationsRef.current.delete(convId);
          if (finished) resyncAttemptsRef.current.delete(key);
        });
    },
    [],
  );

  /**
   * Returns whether the job's assistant message exists and was updated.
   * `jobId` records the owning job as the worker does in its saved copy;
   * approvals, traces and recovery correlate the answer through it.
   */
  const updateAssistantMessage = useCallback(
    (
      convId: string,
      updates: Partial<Message>,
      assistantMessageId?: string,
      jobId?: string,
    ): boolean => {
      const conv = useConversationStore
        .getState()
        .conversations.find((c) => c.id === convId);
      if (!conv || conv.messages.length === 0) return false;

      const target = findAssistantMessage(conv.messages, assistantMessageId);
      if (!target) {
        if (assistantMessageId) resyncConversation(convId, assistantMessageId);
        return false;
      }
      const targetIndex = conv.messages.indexOf(target);

      const nextUpdates = { ...updates };
      if (nextUpdates.errorMessages) {
        if (
          typeof nextUpdates.content === 'string' &&
          isStaleCumulativeSnapshot(target.content, nextUpdates.content)
        ) {
          delete nextUpdates.content;
        }
        if (
          nextUpdates.intermediateSteps &&
          nextUpdates.intermediateSteps.length <
            (target.intermediateSteps?.length || 0)
        ) {
          delete nextUpdates.intermediateSteps;
        }
      }
      if (nextUpdates.intermediateSteps === undefined) {
        delete nextUpdates.intermediateSteps;
      }
      if (jobId && target.metadata?.jobId !== jobId) {
        nextUpdates.metadata = {
          ...target.metadata,
          ...nextUpdates.metadata,
          jobId,
        };
      }

      if (target.id) {
        updateMessage(convId, target.id, nextUpdates);
        return true;
      }
      if (targetIndex === conv.messages.length - 1) {
        updateLastMessage(convId, nextUpdates);
        return true;
      }
      return false;
    },
    [updateMessage, updateLastMessage, resyncConversation],
  );

  /**
   * Save a finished turn only from a copy that contains it. A copy without the
   * job's message predates the turn; saving it would replace the record the
   * worker has just finalized, so reload that record instead. An outcome the
   * worker saved itself (`persisted`) is not uploaded again.
   */
  const persistFinishedTurn = useCallback(
    (
      convId: string,
      updated: boolean,
      assistantMessageId?: string,
      persisted = false,
    ) => {
      if (!updated) {
        if (assistantMessageId) {
          resyncConversation(convId, assistantMessageId, true);
        }
        return;
      }
      if (persisted) return;
      const conversation = useConversationStore
        .getState()
        .conversations.find((c) => c.id === convId);
      if (conversation) {
        void saveConversation(conversation, {
          updatedMessageIds: assistantMessageId ? [assistantMessageId] : [],
        }).catch(() => undefined);
      }
    },
    [resyncConversation],
  );

  /**
   * The single path that puts a run's tool steps on its message. The hook
   * supplies the run's reconciled list; a step the message already holds that
   * the list lacks is kept rather than replaced away.
   */
  const updateStreamingSteps = useCallback(
    (
      convId: string,
      steps: IntermediateStep[] | undefined,
      assistantMessageId?: string,
    ) => {
      if (!steps?.length) return;

      const lastStep = steps[steps.length - 1];
      setActivityText(convId, getCompactActivityText(lastStep));

      const conversation = useConversationStore
        .getState()
        .conversations.find((c) => c.id === convId);
      const target = conversation
        ? findAssistantMessage(conversation.messages, assistantMessageId)
        : null;
      updateAssistantMessage(
        convId,
        {
          intermediateSteps: mergeIntermediateStepSnapshot(
            target?.intermediateSteps,
            steps,
          ),
        },
        assistantMessageId,
      );
    },
    [updateAssistantMessage, setActivityText],
  );

  const flushPendingStreamingUpdates = useCallback(
    function flushPending(conversationId?: string) {
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }

      for (const [key, batch] of Array.from(
        pendingStreamingUpdatesRef.current.entries(),
      )) {
        if (conversationId && batch.conversationId !== conversationId) {
          continue;
        }
        pendingStreamingUpdatesRef.current.delete(key);

        const conversation = useConversationStore
          .getState()
          .conversations.find((item) => item.id === batch.conversationId);
        if (!conversation) continue;
        const assistantMessage = findAssistantMessage(
          conversation.messages,
          batch.assistantMessageId,
        );
        const currentContent =
          typeof assistantMessage?.content === 'string'
            ? assistantMessage.content
            : '';

        updateAssistantMessage(
          batch.conversationId,
          {
            content: reduceStreamingUpdates(currentContent, batch.updates),
            ...(batch.intermediateSteps
              ? {
                  intermediateSteps: mergeIntermediateStepSnapshot(
                    assistantMessage?.intermediateSteps,
                    batch.intermediateSteps,
                  ),
                }
              : {}),
          },
          batch.assistantMessageId,
        );
      }

      if (!conversationId || conversationId === selectedIdRef.current) {
        scrollToBottomSoon();
      }
      lastStreamFlushAtRef.current = Date.now();

      if (pendingStreamingUpdatesRef.current.size > 0) {
        streamFlushTimerRef.current = setTimeout(
          () => flushPending(),
          STREAM_RENDER_INTERVAL_MS,
        );
      }
    },
    [scrollToBottomSoon, updateAssistantMessage],
  );

  const queueStreamingUpdate = useCallback(
    (
      conversationId: string,
      assistantMessageId: string | undefined,
      update: BufferedStreamingUpdate,
      intermediateSteps?: IntermediateStep[],
    ) => {
      const key = `${conversationId}\n${assistantMessageId || ''}`;
      const batch = pendingStreamingUpdatesRef.current.get(key) ?? {
        conversationId,
        assistantMessageId,
        updates: [],
      };
      batch.updates.push(update);
      if (intermediateSteps) batch.intermediateSteps = intermediateSteps;
      pendingStreamingUpdatesRef.current.set(key, batch);

      if (!streamFlushTimerRef.current) {
        // Updates queued in the same task still share one render.
        streamFlushTimerRef.current = setTimeout(
          () => flushPendingStreamingUpdates(),
          Math.max(
            0,
            lastStreamFlushAtRef.current +
              STREAM_RENDER_INTERVAL_MS -
              Date.now(),
          ),
        );
      }
    },
    [flushPendingStreamingUpdates],
  );

  useEffect(() => {
    if (isFollowingRef.current) scrollToBottomSoon();
  }, [selectedConversation?.messages?.length, scrollToBottomSoon]);

  useEffect(() => {
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
  }, [selectedConversationId]);

  // Jump straight to the latest messages when switching conversations
  // (no long smooth-scroll animation through the history).
  useEffect(() => {
    isFollowingRef.current = true;
    setShowScrollToBottom(false);
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
      lastScrollTopRef.current = container.scrollTop;
    }
  }, [selectedConversationId]);

  useEffect(() => {
    const pendingStreamingUpdates = pendingStreamingUpdatesRef.current;

    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
      }
      pendingStreamingUpdates.clear();
      Object.values(oauthSuccessTimersRef.current).forEach(clearTimeout);
      oauthSuccessTimersRef.current = {};
    };
  }, []);

  // Conversations removed from this tab (deleted here or on another device).
  // Their jobs may still deliver events before cancellation takes effect.
  const removedConversationIdsRef = useRef<Set<string>>(new Set());
  const markStreaming = useCallback(
    (convId: string) => {
      if (!removedConversationIdsRef.current.has(convId)) {
        setStreaming(convId, true);
      }
    },
    [setStreaming],
  );

  // Async chat hook - handles job submission, WebSocket streaming, polling fallback
  const { startAsyncJob, cancelJob, steerJob, jobStatusByConversationId } =
    useAsyncChat({
      userId,
      onToken: useCallback(
        (event: {
          conversationId?: string;
          jobId?: string;
          content?: string;
          responseStart?: number;
          assistantMessageId?: string;
          intermediateSteps?: IntermediateStep[];
          partialResponse?: string;
        }) => {
          const convId = event.conversationId || selectedIdRef.current;
          if (!convId || !event.content) return;

          const store = useConversationStore.getState();
          if (!store.streamingConversationIds.has(convId)) return;

          // The hook reconciles live deltas with status reads and repaired
          // gaps. Rendering its text keeps this copy in step even when this
          // view missed an earlier update (for example before history loaded).
          queueStreamingUpdate(
            convId,
            event.assistantMessageId,
            typeof event.partialResponse === 'string'
              ? { content: event.partialResponse, replace: true }
              : {
                  content: event.content,
                  responseStart: event.responseStart,
                },
            event.intermediateSteps,
          );
          setActivityText(convId, 'Generating response');
          finishOAuthPromptsForJob(convId, event.jobId, true, true);
        },
        [finishOAuthPromptsForJob, queueStreamingUpdate, setActivityText],
      ),

      // The step itself reaches the message through onProgress, which the
      // hook calls next with the run's reconciled step list.
      onIntermediateStep: useCallback(
        (event: { conversationId?: string }) => {
          const convId = event.conversationId || selectedIdRef.current;
          if (!convId) return;
          markStreaming(convId);
          scrollToBottomSoon();
        },
        [markStreaming, scrollToBottomSoon],
      ),

      onProgress: useCallback(
        (status: any) => {
          const convId = status.conversationId || selectedIdRef.current;
          if (!convId) return;

          // useAsyncChat follows a terminal status with onComplete or onError
          // in the same task (with an empty response too). Those callbacks
          // finish and save the turn once.
          if (status.status === 'completed' || status.status === 'error') {
            return;
          }

          // Tool steps reach the message for every live status, including
          // sibling work that continues while an authorization is pending.
          if (status.intermediateSteps && status.intermediateSteps.length > 0) {
            updateStreamingSteps(
              convId,
              status.intermediateSteps,
              status.assistantMessageId,
            );
          }

          if (
            status.status === 'oauth_required' &&
            (status.authUrl || status.oauthRequests?.length)
          ) {
            const prompts = oauthPromptsFromStatus(status, convId).filter(
              (prompt) =>
                !succeededOAuthPromptKeysRef.current.has(
                  oauthPromptKey(prompt),
                ),
            );
            markStreaming(convId);
            setActivityText(convId, 'Authorization check');
            if (prompts.length === 0) {
              return;
            }
            setOauthPrompts((current) => {
              const incomingKeys = new Set(prompts.map(oauthPromptKey));
              const next = current.filter((prompt) => {
                if (prompt.conversationId !== convId) return true;
                if (!status.jobId) return false;
                if (prompt.jobId && prompt.jobId !== status.jobId) return true;
                if (incomingKeys.has(oauthPromptKey(prompt))) return false;
                return !prompts.some((incoming) =>
                  isSameOAuthServicePrompt(prompt, incoming),
                );
              });
              return [
                ...next,
                ...prompts.flatMap((prompt) => {
                  const key = oauthPromptKey(prompt);
                  const existing = current.find(
                    (candidate) => oauthPromptKey(candidate) === key,
                  );
                  return {
                    ...prompt,
                    opened:
                      existing?.opened ||
                      openedOAuthPromptKeysRef.current.has(key),
                    succeeded: false,
                  };
                }),
              ];
            });
            scrollToBottomSoon();
            return;
          }

          // Mark conversation as streaming
          markStreaming(convId);
          if (status.status === 'streaming') {
            finishOAuthPromptsForJob(convId, status.jobId, true, true);
          }

          if (status.partialResponse) {
            queueStreamingUpdate(convId, status.assistantMessageId, {
              content: status.partialResponse,
              replace: true,
            });
            setActivityText(convId, 'Generating response');
          }
        },
        [
          markStreaming,
          updateStreamingSteps,
          scrollToBottomSoon,
          finishOAuthPromptsForJob,
          queueStreamingUpdate,
          setActivityText,
        ],
      ),

      onComplete: useCallback(
        (
          fullResponse: string,
          intermediateSteps?: any[],
          _finalizedAt?: number,
          conversationId?: string,
          meta?: {
            assistantMessageId?: string;
            jobId?: string;
            generationDurationMs?: number;
            persisted?: boolean;
          },
        ) => {
          const convId = conversationId || selectedIdRef.current;
          if (!convId) return;
          flushPendingStreamingUpdates(convId);

          // Update final message
          const updated = updateAssistantMessage(
            convId,
            {
              content: fullResponse,
              intermediateSteps,
              ...(meta?.generationDurationMs !== undefined
                ? { generationDurationMs: meta.generationDurationMs }
                : {}),
            },
            meta?.assistantMessageId,
            meta?.jobId,
          );

          // Stop streaming
          setStreaming(convId, false);
          setActivityText(convId, '');
          setStreamAnnouncement(convId, 'Response complete');
          finishOAuthPromptsForJob(convId, meta?.jobId, true);

          persistFinishedTurn(
            convId,
            updated,
            meta?.assistantMessageId,
            meta?.persisted,
          );
        },
        [
          setStreaming,
          updateAssistantMessage,
          finishOAuthPromptsForJob,
          flushPendingStreamingUpdates,
          persistFinishedTurn,
          setActivityText,
          setStreamAnnouncement,
        ],
      ),

      onError: useCallback(
        (
          error: string,
          context?: {
            partialResponse?: string;
            intermediateSteps?: any[];
            jobId?: string;
            conversationId?: string;
            assistantMessageId?: string;
            generationDurationMs?: number;
            persisted?: boolean;
          },
        ) => {
          const convId = context?.conversationId || selectedIdRef.current;
          if (!convId) return;
          flushPendingStreamingUpdates(convId);

          console.error('Chat error:', error);

          const errorMessages = buildMessageError(error);

          const conv = useConversationStore
            .getState()
            .conversations.find((c) => c.id === convId);
          if (conv && conv.messages.length > 0) {
            const updated = updateAssistantMessage(
              convId,
              {
                // A transport error may carry no server snapshot. Keep the
                // text already received, including the just-flushed UI buffer.
                ...(context?.partialResponse
                  ? { content: context.partialResponse }
                  : {}),
                intermediateSteps: context?.intermediateSteps,
                ...(context?.generationDurationMs !== undefined
                  ? { generationDurationMs: context.generationDurationMs }
                  : {}),
                errorMessages,
              },
              context?.assistantMessageId,
              context?.jobId,
            );
            persistFinishedTurn(
              convId,
              updated,
              context?.assistantMessageId,
              context?.persisted,
            );
          } else if (conv) {
            addMessage(convId, {
              role: 'assistant',
              content: context?.partialResponse || '',
              intermediateSteps: context?.intermediateSteps,
              errorMessages,
            });
          }

          setStreaming(convId, false);
          setActivityText(convId, '');
          setStreamAnnouncement(convId, 'Response interrupted');
          clearOpenedOAuthPromptsForConversation(convId);
          setOauthPrompts((current) =>
            withoutOAuthPromptsForConversation(current, convId),
          );
        },
        [
          setStreaming,
          updateAssistantMessage,
          addMessage,
          clearOpenedOAuthPromptsForConversation,
          flushPendingStreamingUpdates,
          persistFinishedTurn,
          setActivityText,
          setStreamAnnouncement,
        ],
      ),
    });

  const jobStatusRef = useRef(jobStatusByConversationId);
  jobStatusRef.current = jobStatusByConversationId;

  // A deleted conversation can no longer receive its answer: the worker
  // discards writes to it. Stop that response instead of tracking it.
  useEffect(
    () =>
      useConversationStore.subscribe(
        (state) => state.conversations,
        (conversations, previous) => {
          const remaining = new Set(conversations.map(({ id }) => id));
          const removed = removedConversationIdsRef.current;
          for (const id of Array.from(removed)) {
            if (remaining.has(id)) removed.delete(id);
          }
          for (const { id } of previous) {
            if (remaining.has(id) || removed.has(id)) continue;
            removed.add(id);
            clearOpenedOAuthPromptsForConversation(id);
            setOauthPrompts((current) =>
              withoutOAuthPromptsForConversation(current, id),
            );
            void cancelJob(id)
              .then(() => setStreaming(id, false))
              .catch((error) => {
                console.warn('Failed to stop a deleted conversation', error);
              });
          }
        },
      ),
    [cancelJob, clearOpenedOAuthPromptsForConversation, setStreaming],
  );

  // Send to the conversation selected when the composer submitted, read from
  // the store. Capturing the rendered copy would give the memoized composer a
  // new callback for every streamed flush.
  const handleSend = useCallback(
    async (message: Message) => {
      const store = useConversationStore.getState();
      let selectedConversation = selectedConversationId
        ? store.conversations.find(
            (conversation) => conversation.id === selectedConversationId,
          )
        : undefined;
      if (!selectedConversation) {
        // The selection can name a conversation that no longer exists (for
        // example one deleted on another device). The composer has already
        // cleared its input, so send to a new conversation instead of
        // discarding the message.
        selectedConversation = newConversation();
        store.addConversation(selectedConversation);
        store.selectConversation(selectedConversation.id);
        void persistSelectedConversation(selectedConversation.id);
      }
      const convId = selectedConversation.id;
      isFollowingRef.current = true;
      setShowScrollToBottom(false);

      const turnId = uuidv4();
      const assistantMessageId = uuidv4();
      const messageWithId = { ...message, id: uuidv4() };

      // Add user message to store
      addMessage(convId, messageWithId);

      // Auto-name conversation from first user message
      const isNewConversation = selectedConversation.messages.length === 0;
      const autoNamed = isNewConversation && Boolean(message.content.trim());
      if (autoNamed) {
        const firstLine = message.content.trim().split('\n')[0];
        const name =
          firstLine.slice(0, 60) + (firstLine.length > 60 ? '...' : '');
        updateConversation(convId, { name });
      }

      // Add placeholder assistant message
      const assistantMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        intermediateSteps: [],
        metadata: { turnId, startedAt: Date.now() },
      };
      addMessage(convId, assistantMessage);

      // Mark as streaming
      setStreaming(convId, true);
      setActivityText(convId, 'Starting...');
      setStreamAnnouncement(convId, 'Response started');
      clearOpenedOAuthPromptsForConversation(convId);
      setOauthPrompts((current) =>
        withoutOAuthPromptsForConversation(current, convId),
      );

      // Build the messages array for the backend
      const allMessages = [...selectedConversation.messages, messageWithId];
      const cleanedMessages = cleanMessagesForLLM(allMessages);

      // Build additional props
      const additionalProps: Record<string, any> = {};
      if (enableIntermediateSteps) {
        additionalProps.enableIntermediateSteps = true;
      }

      // Read fresh state to capture the name update.
      const conversationName =
        useConversationStore
          .getState()
          .conversations.find((c) => c.id === convId)?.name ||
        selectedConversation.name;
      const turnChange: ConversationChange = {
        fields: autoNamed ? ['name'] : [],
      };
      // Save the turn (so other devices and a reload show it while it runs)
      // once the server has accepted the request: the upload then does not
      // compete with the chat request itself. The worker saves the outcome.
      const saveTurn = () => {
        const current = useConversationStore
          .getState()
          .conversations.find((c) => c.id === convId);
        if (current) {
          void saveConversation(current, turnChange).catch(() => undefined);
        }
      };

      try {
        await startAsyncJob(
          cleanedMessages,
          additionalProps,
          userId,
          convId,
          conversationName,
          turnId,
          assistantMessageId,
          saveTurn,
        );
      } catch (err: any) {
        // useAsyncChat has already reported this through onError, which saved
        // the turn with its error: no server copy held it yet.
        console.error('Failed to start async job:', err);
        updateAssistantMessage(
          convId,
          {
            content: '',
            errorMessages: buildMessageError(err),
          },
          assistantMessageId,
        );
        setStreaming(convId, false);
        setActivityText(convId, '');
        clearOpenedOAuthPromptsForConversation(convId);
        setOauthPrompts((current) =>
          withoutOAuthPromptsForConversation(current, convId),
        );
      }

      scrollToBottom('auto');
    },
    [
      selectedConversationId,
      addMessage,
      updateConversation,
      setStreaming,
      updateAssistantMessage,
      startAsyncJob,
      enableIntermediateSteps,
      userId,
      scrollToBottom,
      clearOpenedOAuthPromptsForConversation,
      setActivityText,
      setStreamAnnouncement,
    ],
  );

  const handleSteer = useCallback(
    async (instruction: string) => {
      if (selectedConversationId) {
        await steerJob(selectedConversationId, instruction);
      }
    },
    [selectedConversationId, steerJob],
  );

  const handleRetryMessage = useCallback(() => {
    if (!selectedConversation) return;
    const messages = selectedConversation.messages;
    let lastUser: Message | undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      // Directions sent while a response ran are part of that turn, not its
      // prompt; resending one would replace the question being retried.
      if (
        messages[i].role === 'user' &&
        !messages[i].metadata?.steeringCommandId
      ) {
        lastUser = messages[i];
        break;
      }
    }
    if (!lastUser) return;
    const { id: _omitId, ...messageToResend } = lastUser;
    handleSend(messageToResend as Message);
  }, [selectedConversation, handleSend]);

  const handleNewConversation = useCallback(() => {
    const conversation = newConversation();
    const store = useConversationStore.getState();
    store.addConversation(conversation);
    store.selectConversation(conversation.id);
    void persistSelectedConversation(conversation.id);
    setShowChatbar(false);
    void saveConversation(conversation).catch(() => undefined);
  }, [setShowChatbar]);

  const handleStop = useCallback(async () => {
    if (selectedConversationId) {
      flushPendingStreamingUpdates(selectedConversationId);
      const stoppedJob = jobStatusRef.current[selectedConversationId];
      const stoppedMessageId = stoppedJob?.assistantMessageId;
      try {
        await cancelJob(selectedConversationId);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Could not stop the response. Please try again.';
        toast.error(message);
        setStreamAnnouncement(selectedConversationId, message);
        return;
      }
      // Text delivered while cancellation was confirmed belongs to the
      // stopped answer that is saved below.
      flushPendingStreamingUpdates(selectedConversationId);
      setStreaming(selectedConversationId, false);
      setActivityText(selectedConversationId, '');

      const stoppedMessage = findAssistantMessage(
        useConversationStore
          .getState()
          .conversations.find((c) => c.id === selectedConversationId)
          ?.messages || [],
        stoppedMessageId,
      );
      if (stoppedMessage) {
        const updated = updateAssistantMessage(
          selectedConversationId,
          { metadata: { ...stoppedMessage.metadata, stopped: true } },
          stoppedMessage.id,
          stoppedJob?.jobId,
        );
        persistFinishedTurn(selectedConversationId, updated, stoppedMessageId);
      }
      setStreamAnnouncement(selectedConversationId, 'Response stopped');
      clearOpenedOAuthPromptsForConversation(selectedConversationId);
      setOauthPrompts((current) =>
        withoutOAuthPromptsForConversation(current, selectedConversationId),
      );
    }
  }, [
    selectedConversationId,
    cancelJob,
    updateAssistantMessage,
    persistFinishedTurn,
    setStreaming,
    flushPendingStreamingUpdates,
    clearOpenedOAuthPromptsForConversation,
    setActivityText,
    setStreamAnnouncement,
  ]);

  const messages = selectedConversation?.messages || [];
  const hasMessages = messages.length > 0;
  const hiddenMessageCount = Math.max(0, messages.length - visibleMessageCount);
  const visibleMessages =
    hiddenMessageCount > 0 ? messages.slice(hiddenMessageCount) : messages;
  const isAutonomousConversation =
    selectedConversationId === 'autonomous-agent-thoughts';
  const selectedOAuthPrompts = oauthPrompts.filter(
    (prompt) => prompt.conversationId === selectedConversationId,
  );
  const oauthPromptTitle =
    selectedOAuthPrompts.length > 0 &&
    selectedOAuthPrompts.every((prompt) => prompt.succeeded)
      ? 'Google authorization connected'
      : selectedOAuthPrompts.some((prompt) => prompt.opened)
      ? 'Finish authorization in the opened tab'
      : selectedOAuthPrompts.length > 1
      ? 'Google authorizations required'
      : 'Google authorization required';

  return (
    <div className="flex flex-col h-full w-full bg-dark-bg-primary">
      <header className="chat-header app-chrome safe-top flex min-h-14 flex-shrink-0 items-center justify-between gap-2 border-b border-separator/70 px-3 md:px-4">
        <div className="flex items-center gap-3 min-w-0">
          <IconButton
            icon={<IconMenu2 />}
            aria-label="Open conversation history"
            className="chat-header-action md:hidden"
            variant="ghost"
            size="md"
            onClick={toggleChatbar}
          />
          {isAutonomousConversation && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-nvidia-purple/15 border border-nvidia-purple/30 text-nvidia-purple text-[0.75rem] font-medium">
              <IconRobot size={12} />
              Autonomous
            </span>
          )}
          <h1 className="text-sm font-medium text-dark-text-primary truncate">
            {selectedConversation?.name || 'New Chat'}
          </h1>
          {isStreaming && (
            <span className="flex items-center gap-1.5 text-xs text-nvidia-green">
              <span className="w-1.5 h-1.5 rounded-full bg-nvidia-green animate-heartbeat-breathe" />
              Streaming
            </span>
          )}
        </div>
        <IconButton
          icon={<IconPlus />}
          aria-label="New chat"
          variant="ghost"
          size="md"
          onClick={handleNewConversation}
          className="chat-header-action flex-shrink-0"
        />
      </header>
      <div className="sr-only" role="status" aria-live="polite">
        {streamAnnouncement}
      </div>

      {/* Messages */}
      <div className="chat-message-pane relative min-h-0 flex-1">
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          onWheel={handleWheel}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={() => {
            touchStartYRef.current = null;
          }}
          onKeyDown={handleScrollKeyDown}
          tabIndex={0}
          aria-label="Conversation messages"
          className="chat-scroll-container h-full overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [-webkit-overflow-scrolling:touch]"
        >
          {!hasMessages ? (
            <EmptyState
              onSuggestion={
                isAutonomousConversation
                  ? undefined
                  : (text) =>
                      handleSend({ role: 'user', content: text, metadata: {} })
              }
            />
          ) : (
            <div className="chat-content-rail py-6 space-y-6">
              {hiddenMessageCount > 0 && (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() =>
                      setVisibleMessageCount((count) =>
                        Math.min(
                          messages.length,
                          count + LOAD_OLDER_MESSAGES_STEP,
                        ),
                      )
                    }
                    className="rounded-md border border-separator/70 bg-fill/[0.03] px-3 py-1.5 text-xs text-dark-text-muted hover:text-dark-text-primary"
                  >
                    Show{' '}
                    {Math.min(hiddenMessageCount, LOAD_OLDER_MESSAGES_STEP)}{' '}
                    older messages
                  </button>
                </div>
              )}

              {visibleMessages.map((msg, i) => {
                const messageIndex = hiddenMessageCount + i;
                const isLastMessage = messageIndex === messages.length - 1;
                const ingestProgress = selectedConversationId
                  ? jobStatusByConversationId[selectedConversationId]
                      ?.ingestProgress
                  : undefined;
                const isAssistantStreaming =
                  isStreaming &&
                  isLastMessage &&
                  msg.role !== 'user' &&
                  !ingestProgress;

                const canRetry =
                  isLastMessage &&
                  msg.role !== 'user' &&
                  msg.errorMessages?.recoverable === true &&
                  !isStreaming;
                return (
                  <MessageBubble
                    key={msg.id || `msg-${messageIndex}`}
                    message={msg}
                    messageIndex={messageIndex}
                    isStreaming={isAssistantStreaming}
                    activityProgress={
                      isAssistantStreaming
                        ? {
                            status: selectedConversationId
                              ? jobStatusByConversationId[
                                  selectedConversationId
                                ]?.status
                              : undefined,
                            startedAt:
                              (selectedConversationId
                                ? jobStatusByConversationId[
                                    selectedConversationId
                                  ]?.createdAt
                                : undefined) || msg.metadata?.startedAt,
                            updatedAt: selectedConversationId
                              ? jobStatusByConversationId[
                                  selectedConversationId
                                ]?.updatedAt
                              : undefined,
                            text: activityText,
                          }
                        : undefined
                    }
                    onRetry={canRetry ? handleRetryMessage : undefined}
                  />
                );
              })}

              {/* Document ingestion progress (replaces heartbeat for ingestion jobs) */}
              {isStreaming &&
              selectedConversationId &&
              jobStatusByConversationId[selectedConversationId]
                ?.ingestProgress ? (
                <div className="w-full">
                  <DocumentIngestProgress
                    progress={
                      jobStatusByConversationId[selectedConversationId]!
                        .ingestProgress!
                    }
                  />
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Jump to latest — shown when the user has scrolled up */}
        {showScrollToBottom && hasMessages && (
          <button
            type="button"
            onClick={jumpToLatest}
            aria-label="Jump to latest messages"
            className="absolute bottom-4 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-separator/70 bg-dark-bg-elevated/90 text-dark-text-secondary shadow-lg backdrop-blur-md transition-colors hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:h-10 md:w-10"
          >
            <IconArrowDown size={20} />
          </button>
        )}
      </div>

      {selectedOAuthPrompts.length > 0 && (
        <div className="flex-shrink-0 pb-3">
          <div className="chat-content-rail">
            <div className="flex flex-col gap-2 rounded-md border border-nvidia-green/30 bg-nvidia-green/10 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-sm text-dark-text-primary">
                {oauthPromptTitle}
              </span>
              <div className="flex flex-wrap gap-2">
                {selectedOAuthPrompts.map((prompt) => (
                  <button
                    key={`${prompt.jobId || 'job'}:${prompt.id}`}
                    type="button"
                    className={
                      prompt.succeeded
                        ? 'inline-flex items-center gap-1.5 rounded-md border border-nvidia-green/40 bg-nvidia-green/15 px-3 py-1.5 text-xs font-medium text-nvidia-green'
                        : 'inline-flex items-center gap-1.5 rounded-md bg-action px-3 py-1.5 text-xs font-medium text-on-action hover:bg-action-hover'
                    }
                    onClick={
                      prompt.succeeded
                        ? undefined
                        : () => handleOAuthPromptClick(prompt)
                    }
                    disabled={prompt.succeeded}
                  >
                    {prompt.succeeded ? (
                      <IconCheck size={14} />
                    ) : (
                      <IconExternalLink size={14} />
                    )}
                    {prompt.succeeded
                      ? `${prompt.service || 'Google'} connected`
                      : prompt.opened
                      ? `Reopen ${prompt.service || 'Google'}`
                      : `Connect ${prompt.service || 'Google'}`}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Input - hidden for autonomous agent conversations (read-only) */}
      {isAutonomousConversation ? (
        <div className="flex-shrink-0 border-t border-separator/70 py-3">
          <div className="chat-content-rail">
            <div className="flex items-center justify-center gap-2 py-2 text-xs text-dark-text-muted">
              <IconRobot size={14} className="text-nvidia-purple" />
              <span>This conversation is managed by the autonomous agent</span>
            </div>
          </div>
        </div>
      ) : (
        <ChatInput
          onSend={handleSend}
          onStop={handleStop}
          onSteer={selectedConversationId ? handleSteer : undefined}
          isStreaming={isStreaming}
        />
      )}
    </div>
  );
});

ChatView.displayName = 'ChatView';

const SUGGESTED_PROMPTS = [
  'Run my daily briefing.',
  "Run the last completed week's fantasy football recap for Fowling Friends.",
  "Run the last completed week's fantasy football recap for Driveway Tailgaters.",
];

const EmptyState = memo(
  ({ onSuggestion }: { onSuggestion?: (text: string) => void }) => (
    <div className="chat-empty-state flex min-h-full flex-col items-center px-5 py-6 md:py-8">
      <div className="w-full max-w-md space-y-5 text-center md:my-auto">
        <img
          src={branding.assets['/favicon.png']}
          alt="Daedalus"
          className="h-14 w-auto mx-auto"
        />
        <div className="space-y-2">
          <h2 className="text-3xl font-semibold tracking-tight text-primary">
            How can I help?
          </h2>
          <p className="text-base text-secondary">
            Ask a question, create something, or work through an idea.
          </p>
        </div>
        {onSuggestion && (
          <div className="flex flex-col gap-2">
            {SUGGESTED_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => onSuggestion(prompt)}
                className="min-h-touch-min rounded-xl border border-separator/70 bg-fill/[0.03] px-4 py-2.5 text-sm text-dark-text-secondary transition-colors hover:border-nvidia-green/40 hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  ),
);

EmptyState.displayName = 'EmptyState';
