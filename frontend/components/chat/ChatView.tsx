'use client';

import { IconExternalLink, IconMenu2, IconRobot } from '@tabler/icons-react';
import React, { memo, useCallback, useRef, useEffect, useState } from 'react';

import { useAsyncChat } from '@/hooks/useAsyncChat';

import { saveConversation } from '@/utils/app/conversation';
import { sanitizeMessageContentFromPriorAssistant } from '@/utils/app/conversationReplay';
import { buildMessageError } from '@/utils/app/errorCategory';
import { cleanMessagesForLLM } from '@/utils/app/imageHandler';

import { Message } from '@/types/chat';
import { IntermediateStepCategory } from '@/types/intermediateSteps';

import { useAuth } from '@/components/auth';
import { IconButton } from '@/components/primitives';

import { AgentHeartbeat } from './AgentHeartbeat';
import { ChatInput } from './ChatInput';
import { DocumentIngestProgress } from './DocumentIngestProgress';
import { MessageBubble } from './MessageBubble';

import { useConversationStore, useUISettingsStore } from '@/state';
import { v4 as uuidv4 } from 'uuid';

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
  const chatCompletionURL = useUISettingsStore((s) => s.chatCompletionURL);
  const enableIntermediateSteps = useUISettingsStore(
    (s) => s.enableIntermediateSteps,
  );

  // Streaming state
  const [activityText, setActivityText] = useState('');
  const [stepCategories, setStepCategories] = useState<
    IntermediateStepCategory[]
  >([]);
  const [oauthPrompt, setOauthPrompt] = useState<{
    conversationId: string;
    jobId?: string;
    authUrl: string;
  } | null>(null);
  const streamingIds = useConversationStore((s) => s.streamingConversationIds);
  const isStreaming = selectedConversationId
    ? streamingIds.has(selectedConversationId)
    : false;

  // Refs for async callbacks
  const selectedIdRef = useRef(selectedConversationId);
  selectedIdRef.current = selectedConversationId;

  // Scroll management
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

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

  useEffect(() => {
    scrollToBottom();
  }, [selectedConversation?.messages?.length, scrollToBottom]);

  useEffect(() => {
    setOauthPrompt((current) =>
      current && current.conversationId !== selectedConversationId
        ? null
        : current,
    );
  }, [selectedConversationId]);

  // Async chat hook - handles job submission, WebSocket streaming, polling fallback
  const { startAsyncJob, cancelJob, jobStatusByConversationId } = useAsyncChat({
    userId,
    onProgress: useCallback(
      (status: any) => {
        const convId = status.conversationId || selectedIdRef.current;
        if (!convId) return;

        if (status.status === 'oauth_required' && status.authUrl) {
          setStreaming(convId, true);
          setActivityText('Waiting for Google authorization');
          setOauthPrompt({
            conversationId: convId,
            jobId: status.jobId,
            authUrl: status.authUrl,
          });
          scrollToBottom();
          return;
        }

        setOauthPrompt((current) => {
          if (!current || current.conversationId !== convId) return current;
          if (current.jobId && status.jobId && current.jobId !== status.jobId) {
            return current;
          }
          return null;
        });

        // Detect completion in onProgress as a safety net
        // (onComplete may not fire if fullResponse is empty)
        if (status.status === 'completed' || status.status === 'error') {
          const store = useConversationStore.getState();
          setOauthPrompt((current) =>
            current?.conversationId === convId ? null : current,
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
          setOauthPrompt((current) =>
            current?.conversationId === convId ? null : current,
          );
        }

        // Update activity text from intermediate steps
        if (status.intermediateSteps && status.intermediateSteps.length > 0) {
          const lastStep =
            status.intermediateSteps[status.intermediateSteps.length - 1];
          const rawEvent = lastStep?.payload?.event_type;
          const friendly: Record<string, string> = {
            WORKFLOW_START: 'Starting',
            WORKFLOW_END: 'Finalizing',
            TOOL_START: 'Running tool',
            TOOL_END: 'Tool complete',
            LLM_NEW_TOKEN: 'Generating',
          };
          setActivityText(friendly[rawEvent] || lastStep?.name || 'Processing');

          // Collect step categories
          const cats = status.intermediateSteps
            .map((s: any) => s?.payload?.category || 'tool')
            .filter(Boolean) as IntermediateStepCategory[];
          setStepCategories(cats);

          // Update intermediate steps on the assistant message
          const conv = useConversationStore
            .getState()
            .conversations.find((c) => c.id === convId);
          if (conv && conv.messages.length > 0) {
            updateAssistantMessage(
              convId,
              {
                intermediateSteps: status.intermediateSteps,
              },
              status.assistantMessageId,
            );
          }
        }

        // Do not render partialResponse as message content. In multi-cycle NAT
        // workflows it concatenates interim LLM reasoning that does not represent
        // the final answer. The message `content` is set only in onComplete from
        // fullResponse (and in the status===completed/error branch above as a
        // safety-net).
        if (status.partialResponse) {
          scrollToBottom();
        }
      },
      [setStreaming, updateAssistantMessage, scrollToBottom],
    ),

    onComplete: useCallback(
      (
        fullResponse: string,
        intermediateSteps?: any[],
        finalizedAt?: number,
        conversationId?: string,
        meta?: { assistantMessageId?: string },
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
        setOauthPrompt((current) =>
          current?.conversationId === convId ? null : current,
        );

        // Save to Redis
        const updatedConv = useConversationStore
          .getState()
          .conversations.find((c) => c.id === convId);
        if (updatedConv) {
          saveConversation({ ...updatedConv, updatedAt: Date.now() });
        }

        scrollToBottom();
      },
      [setStreaming, updateAssistantMessage, scrollToBottom],
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
        setOauthPrompt((current) =>
          current?.conversationId === convId ? null : current,
        );
      },
      [setStreaming, updateAssistantMessage, addMessage],
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
      setOauthPrompt(null);

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
          chatCompletionURL,
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
        setOauthPrompt(null);
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
      chatCompletionURL,
      enableIntermediateSteps,
      userId,
      scrollToBottom,
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
      setOauthPrompt(null);
    }
  }, [selectedConversationId, cancelJob, setStreaming]);

  const messages = selectedConversation?.messages || [];
  const hasMessages = messages.length > 0;
  const isAutonomousConversation =
    selectedConversationId === 'autonomous-agent-thoughts';

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
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto scrollbar-hide"
      >
        {!hasMessages ? (
          <EmptyState />
        ) : (
          <div className="chat-content-rail py-6 space-y-6">
            {messages.map((msg, i) => {
              const isLastMessage = i === messages.length - 1;
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
                  key={msg.id || `msg-${i}`}
                  message={msg}
                  messageIndex={i}
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

      {oauthPrompt && oauthPrompt.conversationId === selectedConversationId && (
        <div className="flex-shrink-0 pb-3">
          <div className="chat-content-rail">
            <div className="flex items-center justify-between gap-3 rounded-md border border-nvidia-green/30 bg-nvidia-green/10 px-3 py-2">
              <span className="truncate text-sm text-dark-text-primary">
                Google authorization required
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md bg-nvidia-green px-3 py-1.5 text-xs font-medium text-black hover:bg-nvidia-green/90"
                onClick={() =>
                  window.open(
                    oauthPrompt.authUrl,
                    '_blank',
                    'noopener,noreferrer',
                  )
                }
              >
                <IconExternalLink size={14} />
                Connect Google
              </button>
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

const EmptyState = memo(() => (
  <div className="h-full flex flex-col items-center justify-center px-4">
    <div className="text-center animate-morph-in space-y-4 max-w-sm">
      <img
        src="/main-logo.png"
        alt="Daedalus"
        className="h-20 w-auto mx-auto opacity-60"
      />
      <div>
        <h2 className="text-xl font-semibold text-dark-text-primary">
          Daedalus
        </h2>
        <p className="mt-2 text-sm text-dark-text-muted leading-relaxed">
          Your AI agent with access to 50+ tools including web search, image
          generation, document analysis, code review, and more.
        </p>
      </div>
    </div>
  </div>
));

EmptyState.displayName = 'EmptyState';
