'use client';

import {
  IconArrowDown,
  IconCheck,
  IconExternalLink,
  IconMenu2,
  IconRobot,
} from '@tabler/icons-react';
import React, { memo, useCallback, useRef, useEffect, useState } from 'react';

import { useAsyncChat } from '@/hooks/useAsyncChat';

import { saveConversation } from '@/utils/app/conversation';
import { sanitizeMessageContentFromPriorAssistant } from '@/utils/app/conversationReplay';
import { buildMessageError } from '@/utils/app/errorCategory';
import { cleanMessagesForLLM } from '@/utils/app/imageHandler';
import { getFriendlyName } from '@/utils/app/intermediateSteps';
import {
  OAuthPrompt,
  oauthPromptConversationKeyPrefix,
  oauthPromptKey,
  oauthPromptsFromStatus,
  withoutOAuthPromptsForConversation,
} from '@/utils/app/oauthPrompts';

import { Message } from '@/types/chat';
import {
  getEventCategory,
  IntermediateStep,
  IntermediateStepCategory,
} from '@/types/intermediateSteps';

import { useAuth } from '@/components/auth';
import { IconButton } from '@/components/primitives';

import { AgentHeartbeat } from './AgentHeartbeat';
import { ChatInput } from './ChatInput';
import { DocumentIngestProgress } from './DocumentIngestProgress';
import { MessageBubble } from './MessageBubble';

import { useConversationStore, useUISettingsStore } from '@/state';
import { v4 as uuidv4 } from 'uuid';

const MAX_HEARTBEAT_CATEGORIES = 24;
const INITIAL_VISIBLE_MESSAGES = 80;
const LOAD_OLDER_MESSAGES_STEP = 40;
const OAUTH_SUCCESS_VISIBLE_MS = 3000;
// Within this distance of the bottom the view still counts as "at bottom"
// and streaming auto-scroll stays engaged.
const AT_BOTTOM_THRESHOLD_PX = 120;

type OAuthPromptState = OAuthPrompt & {
  opened?: boolean;
  succeeded?: boolean;
};

function findAssistantMessage(
  messages: Message[],
  assistantMessageId?: string,
): Message | null {
  if (assistantMessageId) {
    const byId = messages.find((message) => message.id === assistantMessageId);
    if (byId && byId.role !== 'user') return byId;
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== 'user') {
      return messages[i];
    }
  }

  return null;
}

function mergeIntermediateStep(
  existingSteps: IntermediateStep[] = [],
  incomingStep?: IntermediateStep,
): IntermediateStep[] {
  if (!incomingStep) return existingSteps;

  const incomingId = incomingStep.payload?.UUID;
  if (!incomingId) return [...existingSteps, incomingStep];

  const existingIndex = existingSteps.findIndex(
    (step) => step.payload?.UUID === incomingId,
  );
  if (existingIndex === -1) {
    return [...existingSteps, incomingStep];
  }

  const nextSteps = [...existingSteps];
  nextSteps[existingIndex] = {
    ...nextSteps[existingIndex],
    ...incomingStep,
    payload: {
      ...nextSteps[existingIndex].payload,
      ...incomingStep.payload,
    },
  };
  return nextSteps;
}

function getStepCategory(step: IntermediateStep): IntermediateStepCategory {
  if (step?.payload?.event_type) {
    return getEventCategory(step.payload.event_type);
  }
  return IntermediateStepCategory.CUSTOM;
}

function getCompactActivityText(step: IntermediateStep): string {
  try {
    return getFriendlyName(step) || 'Working';
  } catch {
    return 'Working';
  }
}

function appendStreamingContent(currentContent: string, delta: string): string {
  if (!delta) return currentContent;
  if (!currentContent) return delta;

  const maxOverlap = Math.min(currentContent.length, delta.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (currentContent.endsWith(delta.slice(0, overlap))) {
      return `${currentContent}${delta.slice(overlap)}`;
    }
  }

  return `${currentContent}${delta}`;
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

function oauthPromptServiceKey(prompt: OAuthPromptState): string {
  return [
    prompt.conversationId,
    prompt.jobId || '',
    prompt.service || 'Google',
  ].join('\n');
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

  const toggleChatbar = useUISettingsStore((s) => s.toggleChatbar);
  const enableIntermediateSteps = useUISettingsStore(
    (s) => s.enableIntermediateSteps,
  );

  // Streaming state
  const [activityText, setActivityText] = useState('');
  const [stepCategories, setStepCategories] = useState<
    IntermediateStepCategory[]
  >([]);
  const [oauthPrompts, setOauthPrompts] = useState<OAuthPromptState[]>([]);
  const [visibleMessageCount, setVisibleMessageCount] = useState(
    INITIAL_VISIBLE_MESSAGES,
  );
  const openedOAuthPromptKeysRef = useRef<Set<string>>(new Set());
  const succeededOAuthServiceKeysRef = useRef<Set<string>>(new Set());
  const oauthSuccessTimersRef = useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});
  const streamingIds = useConversationStore((s) => s.streamingConversationIds);
  const isStreaming = selectedConversationId
    ? streamingIds.has(selectedConversationId)
    : false;

  // Refs for async callbacks
  const selectedIdRef = useRef(selectedConversationId);
  selectedIdRef.current = selectedConversationId;

  // Scroll management. Auto-scroll only sticks while the user is at (or
  // near) the bottom; scrolling up to re-read pauses it and shows a
  // "jump to latest" affordance instead of yanking the view back down.
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const atBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      AT_BOTTOM_THRESHOLD_PX;
    isAtBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    isAtBottomRef.current = true;
    setShowScrollToBottom(false);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const scrollToBottomSoon = useCallback(() => {
    if (!isAtBottomRef.current) return;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const container = scrollContainerRef.current;
      if (container && isAtBottomRef.current) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }, []);

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
      for (const key of Array.from(succeededOAuthServiceKeysRef.current)) {
        if (key.startsWith(prefix)) {
          succeededOAuthServiceKeysRef.current.delete(key);
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
      setOauthPrompts((current) =>
        current.flatMap((prompt) => {
          if (prompt.conversationId !== conversationId) return [prompt];
          if (jobId && prompt.jobId && prompt.jobId !== jobId) return [prompt];
          if (succeeded && prompt.opened) {
            succeededOAuthServiceKeysRef.current.add(
              oauthPromptServiceKey(prompt),
            );
            if (!prompt.succeeded) {
              scheduleOAuthPromptSuccessRemoval(oauthPromptKey(prompt));
            }
            return [{ ...prompt, succeeded: true }];
          }
          if (keepUnopened) return [prompt];
          return [];
        }),
      );
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

  const updateAssistantMessage = useCallback(
    (
      convId: string,
      updates: Partial<Message>,
      assistantMessageId?: string,
    ) => {
      const conv = useConversationStore
        .getState()
        .conversations.find((c) => c.id === convId);
      if (!conv || conv.messages.length === 0) return;

      let targetIndex = assistantMessageId
        ? conv.messages.findIndex(
            (message) => message.id === assistantMessageId,
          )
        : -1;

      if (targetIndex === -1) {
        for (let i = conv.messages.length - 1; i >= 0; i -= 1) {
          if (conv.messages[i].role !== 'user') {
            targetIndex = i;
            break;
          }
        }
      }

      if (targetIndex === -1) return;

      const target = conv.messages[targetIndex];
      if (target.role === 'user') return;

      const nextUpdates = { ...updates };
      if (typeof nextUpdates.content === 'string') {
        nextUpdates.content = sanitizeMessageContentFromPriorAssistant(
          nextUpdates.content,
          conv.messages.slice(0, targetIndex),
        );
      }
      if (nextUpdates.intermediateSteps === undefined) {
        delete nextUpdates.intermediateSteps;
      }

      if (target.id) {
        updateMessage(convId, target.id, nextUpdates);
      } else if (targetIndex === conv.messages.length - 1) {
        updateLastMessage(convId, nextUpdates);
      }
    },
    [updateMessage, updateLastMessage],
  );

  const updateStreamingSteps = useCallback(
    (
      convId: string,
      steps: IntermediateStep[] | undefined,
      assistantMessageId?: string,
    ) => {
      if (!steps?.length) return;

      const lastStep = steps[steps.length - 1];
      setActivityText(getCompactActivityText(lastStep));
      setStepCategories(
        steps.map(getStepCategory).slice(-MAX_HEARTBEAT_CATEGORIES),
      );

      updateAssistantMessage(
        convId,
        {
          intermediateSteps: steps,
        },
        assistantMessageId,
      );
    },
    [updateAssistantMessage],
  );

  const appendStreamingStep = useCallback(
    (
      convId: string,
      step: IntermediateStep | undefined,
      assistantMessageId?: string,
    ) => {
      if (!step) return;

      const conv = useConversationStore
        .getState()
        .conversations.find((c) => c.id === convId);
      if (!conv) return;

      const assistantMessage = findAssistantMessage(
        conv.messages,
        assistantMessageId,
      );
      const nextSteps = mergeIntermediateStep(
        assistantMessage?.intermediateSteps || [],
        step,
      );

      setActivityText(getCompactActivityText(step));
      setStepCategories((current) =>
        [...current, getStepCategory(step)].slice(-MAX_HEARTBEAT_CATEGORIES),
      );
      updateAssistantMessage(
        convId,
        {
          intermediateSteps: nextSteps,
        },
        assistantMessageId,
      );
    },
    [updateAssistantMessage],
  );

  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom();
    }
  }, [selectedConversation?.messages?.length, scrollToBottom]);

  useEffect(() => {
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
  }, [selectedConversationId]);

  // Jump straight to the latest messages when switching conversations
  // (no long smooth-scroll animation through the history).
  useEffect(() => {
    isAtBottomRef.current = true;
    setShowScrollToBottom(false);
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [selectedConversationId]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
      Object.values(oauthSuccessTimersRef.current).forEach(clearTimeout);
      oauthSuccessTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    setOauthPrompts((current) =>
      current.filter(
        (prompt) => prompt.conversationId === selectedConversationId,
      ),
    );
  }, [selectedConversationId]);

  // Async chat hook - handles job submission, WebSocket streaming, polling fallback
  const { startAsyncJob, cancelJob, jobStatusByConversationId } = useAsyncChat({
    userId,
    onToken: useCallback(
      (event: {
        conversationId?: string;
        jobId?: string;
        content?: string;
        assistantMessageId?: string;
        intermediateSteps?: IntermediateStep[];
      }) => {
        const convId = event.conversationId || selectedIdRef.current;
        if (!convId || !event.content) return;

        const store = useConversationStore.getState();
        if (!store.streamingConversationIds.has(convId)) return;

        const conv = store.conversations.find((c) => c.id === convId);
        if (!conv) return;

        const assistantMessage = findAssistantMessage(
          conv.messages,
          event.assistantMessageId,
        );
        const currentContent =
          typeof assistantMessage?.content === 'string'
            ? assistantMessage.content
            : '';

        updateAssistantMessage(
          convId,
          {
            content: appendStreamingContent(currentContent, event.content),
            ...(event.intermediateSteps
              ? { intermediateSteps: event.intermediateSteps }
              : {}),
          },
          event.assistantMessageId,
        );
        setActivityText('Generating response');
        finishOAuthPromptsForJob(convId, event.jobId, true, true);
        scrollToBottomSoon();
      },
      [finishOAuthPromptsForJob, scrollToBottomSoon, updateAssistantMessage],
    ),

    onIntermediateStep: useCallback(
      (event: {
        conversationId?: string;
        step?: IntermediateStep;
        assistantMessageId?: string;
      }) => {
        const convId = event.conversationId || selectedIdRef.current;
        if (!convId) return;
        setStreaming(convId, true);
        appendStreamingStep(
          convId,
          event.step as IntermediateStep,
          event.assistantMessageId,
        );
        scrollToBottomSoon();
      },
      [appendStreamingStep, scrollToBottomSoon, setStreaming],
    ),

    onProgress: useCallback(
      (status: any) => {
        const convId = status.conversationId || selectedIdRef.current;
        if (!convId) return;

        if (
          status.status === 'oauth_required' &&
          (status.authUrl || status.oauthRequests?.length)
        ) {
          const prompts = oauthPromptsFromStatus(status, convId).filter(
            (prompt) =>
              !succeededOAuthServiceKeysRef.current.has(
                oauthPromptServiceKey(prompt),
              ),
          );
          setStreaming(convId, true);
          setActivityText('Authorization check');
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
                const related = current.find((candidate) =>
                  isSameOAuthServicePrompt(candidate, prompt),
                );
                if (related?.succeeded) return [related];
                return {
                  ...prompt,
                  opened:
                    existing?.opened ||
                    related?.opened ||
                    openedOAuthPromptKeysRef.current.has(key),
                  succeeded: false,
                };
              }),
            ];
          });
          scrollToBottomSoon();
          return;
        }

        // Detect completion in onProgress as a safety net
        // (onComplete may not fire if fullResponse is empty)
        if (status.status === 'completed' || status.status === 'error') {
          const store = useConversationStore.getState();
          finishOAuthPromptsForJob(
            convId,
            status.jobId,
            status.status === 'completed',
          );
          if (store.streamingConversationIds.has(convId)) {
            // Final update with whatever content we have
            const conv = store.conversations.find((c) => c.id === convId);
            if (conv && conv.messages.length > 0) {
              updateAssistantMessage(
                convId,
                {
                  ...(status.fullResponse || status.partialResponse
                    ? { content: status.fullResponse || status.partialResponse }
                    : {}),
                  intermediateSteps: status.intermediateSteps,
                },
                status.assistantMessageId,
              );
            }
            setStreaming(convId, false);
            setActivityText('');
            setStepCategories([]);
            // Persist
            const updatedConv = useConversationStore
              .getState()
              .conversations.find((c) => c.id === convId);
            if (updatedConv) {
              saveConversation({ ...updatedConv, updatedAt: Date.now() });
            }
            scrollToBottom();
          }
          return;
        }

        // Mark conversation as streaming
        setStreaming(convId, true);
        if (status.status === 'streaming') {
          finishOAuthPromptsForJob(convId, status.jobId, true, true);
        }

        // Update activity text from intermediate steps
        if (status.intermediateSteps && status.intermediateSteps.length > 0) {
          updateStreamingSteps(
            convId,
            status.intermediateSteps,
            status.assistantMessageId,
          );
        }

        if (status.partialResponse) {
          updateAssistantMessage(
            convId,
            {
              content: status.partialResponse,
            },
            status.assistantMessageId,
          );
          setActivityText('Generating response');
          scrollToBottomSoon();
        }
      },
      [
        setStreaming,
        updateAssistantMessage,
        updateStreamingSteps,
        scrollToBottomSoon,
        scrollToBottom,
        finishOAuthPromptsForJob,
      ],
    ),

    onComplete: useCallback(
      (
        fullResponse: string,
        intermediateSteps?: any[],
        finalizedAt?: number,
        conversationId?: string,
        meta?: { assistantMessageId?: string; jobId?: string },
      ) => {
        const convId = conversationId || selectedIdRef.current;
        if (!convId) return;

        // Update final message
        const conv = useConversationStore
          .getState()
          .conversations.find((c) => c.id === convId);
        if (conv && conv.messages.length > 0) {
          updateAssistantMessage(
            convId,
            {
              content: fullResponse,
              intermediateSteps,
            },
            meta?.assistantMessageId,
          );
        }

        // Stop streaming
        setStreaming(convId, false);
        setActivityText('');
        setStepCategories([]);
        finishOAuthPromptsForJob(convId, meta?.jobId, true);

        // Save to Redis
        const updatedConv = useConversationStore
          .getState()
          .conversations.find((c) => c.id === convId);
        if (updatedConv) {
          saveConversation({ ...updatedConv, updatedAt: Date.now() });
        }

        scrollToBottom();
      },
      [
        setStreaming,
        updateAssistantMessage,
        scrollToBottom,
        finishOAuthPromptsForJob,
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
        },
      ) => {
        const convId = context?.conversationId || selectedIdRef.current;
        if (!convId) return;

        console.error('Chat error:', error);

        const errorMessages = buildMessageError(error);

        if (context?.partialResponse) {
          const conv = useConversationStore
            .getState()
            .conversations.find((c) => c.id === convId);
          if (conv && conv.messages.length > 0) {
            updateAssistantMessage(
              convId,
              {
                content: `${context.partialResponse}\n\n*[Response interrupted]*`,
                intermediateSteps: context.intermediateSteps,
                errorMessages,
              },
              context.assistantMessageId,
            );
          }
        } else {
          const conv = useConversationStore
            .getState()
            .conversations.find((c) => c.id === convId);
          if (conv && conv.messages.length > 0) {
            updateAssistantMessage(
              convId,
              {
                content: '',
                intermediateSteps: context?.intermediateSteps,
                errorMessages,
              },
              context?.assistantMessageId,
            );
          } else {
            addMessage(convId, {
              role: 'assistant',
              content: '',
              errorMessages,
            });
          }
        }

        setStreaming(convId, false);
        setActivityText('');
        setStepCategories([]);
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
      ],
    ),
  });

  // Handle message send
  const handleSend = useCallback(
    async (message: Message) => {
      if (!selectedConversation) return;
      const convId = selectedConversation.id;

      const turnId = uuidv4();
      const assistantMessageId = uuidv4();
      const messageWithId = { ...message, id: uuidv4() };

      // Add user message to store
      addMessage(convId, messageWithId);

      // Auto-name conversation from first user message
      const isNewConversation = selectedConversation.messages.length === 0;
      if (isNewConversation && message.content.trim()) {
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
        metadata: { turnId },
      };
      addMessage(convId, assistantMessage);

      // Mark as streaming
      setStreaming(convId, true);
      setActivityText('Starting...');
      setStepCategories([]);
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

      // Persist conversation - read fresh state to capture the name update
      const freshConv = useConversationStore
        .getState()
        .conversations.find((c) => c.id === convId);
      const updatedConv = {
        ...(freshConv || selectedConversation),
        messages: [...allMessages, assistantMessage],
        updatedAt: Date.now(),
      };
      saveConversation(updatedConv);

      try {
        await startAsyncJob(
          cleanedMessages,
          additionalProps,
          userId,
          convId,
          freshConv?.name || selectedConversation.name,
          turnId,
          assistantMessageId,
        );
      } catch (err: any) {
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
        setActivityText('');
        clearOpenedOAuthPromptsForConversation(convId);
        setOauthPrompts((current) =>
          withoutOAuthPromptsForConversation(current, convId),
        );
      }

      scrollToBottom();
    },
    [
      selectedConversation,
      addMessage,
      updateConversation,
      setStreaming,
      updateAssistantMessage,
      startAsyncJob,
      enableIntermediateSteps,
      userId,
      scrollToBottom,
      clearOpenedOAuthPromptsForConversation,
    ],
  );

  const handleRetryMessage = useCallback(() => {
    if (!selectedConversation) return;
    const messages = selectedConversation.messages;
    let lastUser: Message | undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') {
        lastUser = messages[i];
        break;
      }
    }
    if (!lastUser) return;
    const { id: _omitId, ...messageToResend } = lastUser;
    handleSend(messageToResend as Message);
  }, [selectedConversation, handleSend]);

  const handleStop = useCallback(async () => {
    if (selectedConversationId) {
      await cancelJob(selectedConversationId);
      setStreaming(selectedConversationId, false);
      setActivityText('');
      setStepCategories([]);
      clearOpenedOAuthPromptsForConversation(selectedConversationId);
      setOauthPrompts((current) =>
        withoutOAuthPromptsForConversation(current, selectedConversationId),
      );
    }
  }, [
    selectedConversationId,
    cancelJob,
    setStreaming,
    clearOpenedOAuthPromptsForConversation,
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
      {/* Header — safe-top is handled by ViewTabs above on mobile */}
      <header className="flex-shrink-0 flex items-center justify-between px-4 h-14 border-b border-white/[0.04]">
        <div className="flex items-center gap-3 min-w-0">
          <IconButton
            icon={<IconMenu2 />}
            aria-label="Toggle sidebar"
            variant="ghost"
            size="sm"
            onClick={toggleChatbar}
            className="hidden md:flex"
          />
          {isAutonomousConversation && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-nvidia-purple/15 border border-nvidia-purple/30 text-nvidia-purple text-[10px] font-medium">
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
      </header>

      {/* Messages */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto overscroll-contain scrollbar-hide [-webkit-overflow-scrolling:touch]"
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
                    className="rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs text-dark-text-muted hover:text-dark-text-primary"
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
              ) : (
                isStreaming && (
                  <div className="w-full">
                    <AgentHeartbeat
                      currentActivityText={activityText}
                      completedStepCategories={stepCategories}
                    />
                  </div>
                )
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Jump to latest — shown when the user has scrolled up */}
        {showScrollToBottom && hasMessages && (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Jump to latest messages"
            className="absolute bottom-4 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-white/[0.1] bg-dark-bg-elevated/90 text-dark-text-secondary shadow-lg backdrop-blur-md transition-colors hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40 md:h-10 md:w-10"
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
                        : 'inline-flex items-center gap-1.5 rounded-md bg-nvidia-green px-3 py-1.5 text-xs font-medium text-black hover:bg-nvidia-green/90'
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
        <div className="flex-shrink-0 border-t border-white/[0.04] py-3">
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
          isStreaming={isStreaming}
        />
      )}
    </div>
  );
});

ChatView.displayName = 'ChatView';

const SUGGESTED_PROMPTS = [
  'Summarize the latest developments on a topic I follow',
  'Help me draft a technical document',
  'Analyze an uploaded file or image',
];

const EmptyState = memo(
  ({ onSuggestion }: { onSuggestion?: (text: string) => void }) => (
    <div className="h-full flex flex-col items-center justify-center px-4">
      <div className="text-center animate-morph-in space-y-5 max-w-sm">
        <img
          src="/main-logo.png"
          alt="Daedalus"
          className="h-20 w-auto mx-auto opacity-60"
        />
        <p className="text-sm text-dark-text-muted">
          Ask a question, attach files, or try one of these:
        </p>
        {onSuggestion && (
          <div className="flex flex-col gap-2">
            {SUGGESTED_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => onSuggestion(prompt)}
                className="min-h-touch-min rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-sm text-dark-text-secondary transition-colors hover:border-nvidia-green/40 hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40"
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
