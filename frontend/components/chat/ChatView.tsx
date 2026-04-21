'use client';

import React, { memo, useCallback, useRef, useEffect, useState } from 'react';
import { IconMenu2, IconRobot } from '@tabler/icons-react';
import { useTranslation } from 'next-i18next';
import { v4 as uuidv4 } from 'uuid';

import { useConversationStore, useUISettingsStore } from '@/state';
import { useAuth } from '@/components/auth';
import { useAsyncChat } from '@/hooks/useAsyncChat';
import { IconButton } from '@/components/primitives';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { AgentHeartbeat } from './AgentHeartbeat';
import { Message, Conversation } from '@/types/chat';
import { saveConversation, saveConversations } from '@/utils/app/conversation';
import { cleanMessagesForLLM } from '@/utils/app/imageHandler';
import { IntermediateStepCategory } from '@/types/intermediateSteps';

export const ChatView = memo(() => {
  const { t } = useTranslation('chat');
  const { user } = useAuth();
  const userId = user?.username || 'anon';

  // Store state
  const selectedConversationId = useConversationStore((s) => s.selectedConversationId);
  const selectedConversation = useConversationStore((s) => {
    const id = s.selectedConversationId;
    return id ? s.conversations.find((c) => c.id === id) ?? null : null;
  });
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const addMessage = useConversationStore((s) => s.addMessage);
  const updateLastMessage = useConversationStore((s) => s.updateLastMessage);
  const setStreaming = useConversationStore((s) => s.setStreaming);

  const toggleChatbar = useUISettingsStore((s) => s.toggleChatbar);
  const chatCompletionURL = useUISettingsStore((s) => s.chatCompletionURL);
  const enableIntermediateSteps = useUISettingsStore((s) => s.enableIntermediateSteps);

  // Streaming state
  const [activityText, setActivityText] = useState('');
  const [stepCategories, setStepCategories] = useState<IntermediateStepCategory[]>([]);
  const streamingIds = useConversationStore((s) => s.streamingConversationIds);
  const isStreaming = selectedConversationId ? streamingIds.has(selectedConversationId) : false;

  // Refs for async callbacks
  const selectedConvRef = useRef(selectedConversation);
  selectedConvRef.current = selectedConversation;
  const selectedIdRef = useRef(selectedConversationId);
  selectedIdRef.current = selectedConversationId;

  // Scroll management
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [selectedConversation?.messages?.length, scrollToBottom]);

  // Async chat hook - handles job submission, WebSocket streaming, polling fallback
  const { startAsyncJob, cancelJob } = useAsyncChat({
    userId,
    onProgress: useCallback((status: any) => {
      const convId = status.conversationId || selectedIdRef.current;
      if (!convId) return;

      // Detect completion in onProgress as a safety net
      // (onComplete may not fire if fullResponse is empty)
      if (status.status === 'completed' || status.status === 'error') {
        const store = useConversationStore.getState();
        if (store.streamingConversationIds.has(convId)) {
          // Final update with whatever content we have
          const conv = store.conversations.find((c) => c.id === convId);
          if (conv && conv.messages.length > 0) {
            const lastMsg = conv.messages[conv.messages.length - 1];
            if (lastMsg.role !== 'user') {
              updateLastMessage(convId, {
                content: status.fullResponse || status.partialResponse || lastMsg.content,
                intermediateSteps: status.intermediateSteps || lastMsg.intermediateSteps,
              });
            }
          }
          setStreaming(convId, false);
          setActivityText('');
          setStepCategories([]);
          // Persist
          const updatedConv = useConversationStore.getState().conversations.find((c) => c.id === convId);
          if (updatedConv) {
            saveConversation({ ...updatedConv, updatedAt: Date.now() });
          }
          scrollToBottom();
        }
        return;
      }

      // Mark conversation as streaming
      setStreaming(convId, true);

      // Update activity text from intermediate steps
      if (status.intermediateSteps && status.intermediateSteps.length > 0) {
        const lastStep = status.intermediateSteps[status.intermediateSteps.length - 1];
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
        const conv = useConversationStore.getState().conversations.find((c) => c.id === convId);
        if (conv && conv.messages.length > 0) {
          const lastMsg = conv.messages[conv.messages.length - 1];
          if (lastMsg.role !== 'user') {
            updateLastMessage(convId, {
              intermediateSteps: status.intermediateSteps,
            });
          }
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
    }, [setStreaming, updateLastMessage, scrollToBottom]),

    onComplete: useCallback((fullResponse: string, intermediateSteps?: any[], finalizedAt?: number, conversationId?: string) => {
      const convId = conversationId || selectedIdRef.current;
      if (!convId) return;

      // Update final message
      const conv = useConversationStore.getState().conversations.find((c) => c.id === convId);
      if (conv && conv.messages.length > 0) {
        const lastMsg = conv.messages[conv.messages.length - 1];
        if (lastMsg.role !== 'user') {
          updateLastMessage(convId, {
            content: fullResponse,
            intermediateSteps: intermediateSteps || lastMsg.intermediateSteps,
          });
        }
      }

      // Stop streaming
      setStreaming(convId, false);
      setActivityText('');
      setStepCategories([]);

      // Save to Redis
      const updatedConv = useConversationStore.getState().conversations.find((c) => c.id === convId);
      if (updatedConv) {
        saveConversation({ ...updatedConv, updatedAt: Date.now() });
      }

      scrollToBottom();
    }, [setStreaming, updateLastMessage, scrollToBottom]),

    onError: useCallback((error: string, context?: { partialResponse?: string; intermediateSteps?: any[]; jobId?: string; conversationId?: string }) => {
      const convId = context?.conversationId || selectedIdRef.current;
      if (!convId) return;

      console.error('Chat error:', error);

      // If there's a partial response, keep it
      if (context?.partialResponse) {
        const conv = useConversationStore.getState().conversations.find((c) => c.id === convId);
        if (conv && conv.messages.length > 0) {
          updateLastMessage(convId, {
            content: context.partialResponse + '\n\n*[Response interrupted]*',
            intermediateSteps: context.intermediateSteps,
          });
        }
      } else {
        // Add error message
        addMessage(convId, {
          role: 'assistant',
          content: `An error occurred: ${error}`,
        });
      }

      setStreaming(convId, false);
      setActivityText('');
      setStepCategories([]);
    }, [setStreaming, updateLastMessage, addMessage]),
  });

  // Handle message send
  const handleSend = useCallback(async (message: Message) => {
    if (!selectedConversation) return;
    const convId = selectedConversation.id;

    const messageWithId = { ...message, id: uuidv4() };

    // Add user message to store
    addMessage(convId, messageWithId);

    // Auto-name conversation from first user message
    const isNewConversation = selectedConversation.messages.length === 0;
    if (isNewConversation && message.content.trim()) {
      const firstLine = message.content.trim().split('\n')[0];
      const name = firstLine.slice(0, 60) + (firstLine.length > 60 ? '...' : '');
      updateConversation(convId, { name });
    }

    // Add placeholder assistant message
    const assistantMessage: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      intermediateSteps: [],
    };
    addMessage(convId, assistantMessage);

    // Mark as streaming
    setStreaming(convId, true);
    setActivityText('Starting...');
    setStepCategories([]);

    // Build the messages array for the backend
    const allMessages = [...selectedConversation.messages, messageWithId];
    const cleanedMessages = cleanMessagesForLLM(allMessages);

    // Build additional props
    const additionalProps: Record<string, any> = {};
    if (enableIntermediateSteps) {
      additionalProps.enableIntermediateSteps = true;
    }

    // Persist conversation - read fresh state to capture the name update
    const freshConv = useConversationStore.getState().conversations.find((c) => c.id === convId);
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
      );
    } catch (err: any) {
      console.error('Failed to start async job:', err);
      updateLastMessage(convId, {
        content: `Failed to send message: ${err.message || 'Unknown error'}`,
      });
      setStreaming(convId, false);
      setActivityText('');
    }

    scrollToBottom();
  }, [selectedConversation, addMessage, updateConversation, setStreaming, updateLastMessage,
      startAsyncJob, chatCompletionURL, enableIntermediateSteps, userId, t, scrollToBottom]);

  const handleStop = useCallback(async () => {
    if (selectedConversationId) {
      await cancelJob(selectedConversationId);
      setStreaming(selectedConversationId, false);
      setActivityText('');
      setStepCategories([]);
    }
  }, [selectedConversationId, cancelJob, setStreaming]);

  const messages = selectedConversation?.messages || [];
  const hasMessages = messages.length > 0;
  const isAutonomousConversation = selectedConversationId === 'autonomous-agent-thoughts';

  return (
    <div
      className="flex flex-col h-full w-full bg-dark-bg-primary"
    >
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
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
            {messages.map((msg, i) => {
              const isLastMessage = i === messages.length - 1;
              const isAssistantStreaming = isStreaming && isLastMessage && msg.role !== 'user';

              return (
                <MessageBubble
                  key={msg.id || `msg-${i}`}
                  message={msg}
                  messageIndex={i}
                  isStreaming={isAssistantStreaming}
                />
              );
            })}

            {/* Agent heartbeat during streaming */}
            {isStreaming && (
              <div className="max-w-3xl mx-auto">
                <AgentHeartbeat
                  currentActivityText={activityText}
                  completedStepCategories={stepCategories}
                />
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input - hidden for autonomous agent conversations (read-only) */}
      {isAutonomousConversation ? (
        <div className="flex-shrink-0 px-4 py-3 border-t border-white/[0.04]">
          <div className="max-w-3xl mx-auto flex items-center justify-center gap-2 py-2 text-xs text-dark-text-muted">
            <IconRobot size={14} className="text-nvidia-purple" />
            <span>This conversation is managed by the autonomous agent</span>
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
      <img src="/main-logo.png" alt="Daedalus" className="h-20 w-auto mx-auto opacity-60" />
      <div>
        <h2 className="text-xl font-semibold text-dark-text-primary">Daedalus</h2>
        <p className="mt-2 text-sm text-dark-text-muted leading-relaxed">
          Your AI agent with access to 50+ tools including web search, image generation,
          document analysis, code review, and more.
        </p>
      </div>
    </div>
  </div>
));

EmptyState.displayName = 'EmptyState';
