'use client';
import { IconBrain, IconArrowDown, IconTool } from '@tabler/icons-react';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import toast from 'react-hot-toast';

import { useTranslation } from 'next-i18next';

import { getEndpoint } from '@/utils/app/api';
import {
  saveConversation,
  saveConversations,
  updateConversation,
} from '@/utils/app/conversation';
import {
  fetchLastMessage,
} from '@/utils/app/helper';
import { throttle } from '@/utils/data/throttle';
import { debounce } from 'lodash';
import { getUserSessionItem } from '@/utils/app/storage';
import { ChatBody, Conversation, Message } from '@/types/chat';
import {
  IntermediateStep,
  IntermediateStepCategory,
  IntermediateStepState,
  IntermediateStepType,
  getEventCategory,
  getEventState,
} from '@/types/intermediateSteps';
import { SSEClient, createSSEUrl } from '@/services/sse';
import HomeContext from '@/pages/api/home/home.context';
import { ChatHeader } from './ChatHeader';
import { ChatInput } from './ChatInput';
import { ChatLoader } from './ChatLoader';
import { AgentHeartbeat } from './AgentHeartbeat';
import { MemoizedChatMessage } from './MemoizedChatMessage';
import { VirtualMessageList } from './VirtualMessageList';
import { cleanMessagesForLLM, processMessageImages } from '@/utils/app/imageHandler';
import { GalaxyAnimation } from '@/components/GalaxyAnimation';
import { BackgroundProcessingIndicator } from '@/components/PWA/BackgroundProcessingIndicator';
import { ChatLoadingSkeleton } from '@/components/UI/Skeleton';

import { v4 as uuidv4 } from 'uuid';
import { useAuth } from '@/components/Auth/AuthProvider';
import { useIOSKeyboardFix } from '@/hooks/useIOSKeyboardFix';
import { useVisualViewport } from '@/hooks/useVisualViewport';
import { notifyStreamingComplete, requestNotificationPermission } from '@/utils/notifications';
import { useAsyncChat } from '@/hooks/useAsyncChat';
import { useConversationSync } from '@/hooks/useConversationSync';
import { useBackgroundProcessing } from '@/hooks/useBackgroundProcessing';
import { getWebSocketManager } from '@/services/websocket';
import { useOrientation } from './hooks/useOrientation';
import { Logger } from '@/utils/logger';

const logger = new Logger('ChatComponent');

function stepToActivityText(step: IntermediateStep): string | null {
  const { event_type, name } = step.payload;
  if (event_type === IntermediateStepType.TOOL_START) {
    const toolName = (name ?? '').toLowerCase();
    if (toolName.includes('search') || toolName.includes('serp')) return 'Searching the web...';
    if (toolName.includes('retriev') || toolName.includes('milvus') || toolName.includes('knowledge')) return 'Searching knowledge base...';
    if (toolName.includes('image') || toolName.includes('generat')) return 'Generating image...';
    if (toolName.includes('scrape') || toolName.includes('browse') || toolName.includes('fetch') || toolName.includes('web_')) return 'Reading web page...';
    if (toolName.includes('code') || toolName.includes('python') || toolName.includes('exec')) return 'Running code...';
    return name ? `Using ${name}...` : 'Using tool...';
  }
  if (event_type === IntermediateStepType.LLM_START) return 'Reasoning...';
  if (event_type === IntermediateStepType.WORKFLOW_START) return 'Starting workflow...';
  if (event_type === IntermediateStepType.TASK_START) return name ? `Running ${name}...` : 'Running task...';
  if (event_type === IntermediateStepType.TTC_START) return 'Evaluating candidates...';
  return null;
}

export const Chat = () => {
  const { t } = useTranslation('chat');
  const { user, isLoading: authLoading } = useAuth();
  const {
    state: {
      selectedConversation,
      conversations,
      messageIsStreaming,
      streamingByConversationId,
      loading,
      chatHistory,
      chatCompletionURL,
      expandIntermediateSteps,
      intermediateStepOverride,
      enableIntermediateSteps,
      useDeepThinker,
      enableBackgroundProcessing
    },
    handleUpdateConversation,
    dispatch: homeDispatch,
    quickActionHandlers,
  } = useContext(HomeContext);

  const [currentMessage, setCurrentMessage] = useState<Message>();
  const [autoScrollEnabled, setAutoScrollEnabled] = useState<boolean>(true);
  const [showScrollDownButton, setShowScrollDownButton] =
    useState<boolean>(false);
  const [userScrollLocked, setUserScrollLocked] = useState<boolean>(false);
  const [currentActivityText, setCurrentActivityText] = useState<string>('');
  const [completedStepCategories, setCompletedStepCategories] = useState<IntermediateStepCategory[]>([]);

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const controllerByConversationRef = useRef<Record<string, AbortController>>({});
  const streamReaderByConversationRef = useRef<Record<string, ReadableStreamDefaultReader<Uint8Array> | null>>({});
  const selectedConversationRef = useRef(selectedConversation);
  // Keep ref always in sync to avoid stale closures in async callbacks
  selectedConversationRef.current = selectedConversation;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const streamingByConversationIdRef = useRef(streamingByConversationId);
  streamingByConversationIdRef.current = streamingByConversationId;
  const asyncConversationIdRef = useRef<string | null>(null);
  const selectedControllerRef = useRef<AbortController>(new AbortController());
  const streamGenerationRef = useRef<Record<string, number>>({});
  const lastStreamingSaveRef = useRef<number>(0);

  const lastScrollTop = useRef(0); // Store last known scroll position
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null); // Debounce scroll events
  const autoScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null); // Delay auto-scroll re-enabling
  const lastMessageCount = useRef(0); // Track message count to only scroll on new messages
  const lastStreamedContentLengthRef = useRef(0); // Track assistant content length during streaming
  // Refs that mirror state for use in stable callbacks (avoids recreating handlers on every state change,
  // which would cause VirtualMessageList to re-render via onScroll prop changes)
  const autoScrollEnabledRef = useRef(autoScrollEnabled);
  autoScrollEnabledRef.current = autoScrollEnabled;
  const userScrollLockedRef = useRef(userScrollLocked);
  userScrollLockedRef.current = userScrollLocked;
  const prevStreamingRef = useRef<boolean>(false);

  // Prevent huge inline image payloads from rendering during streaming (mobile safety)
  const sanitizeInlineImagesForDisplay = useCallback((content?: string) => {
    if (!content) {
      return '';
    }

    const hasInlineImage = content.includes('data:image/');
    const replaced = content.replace(
      /!\[([^\]]*)\]\(data:image\/[^\)]+\)/g,
      '![$1](loading)'
    );

    const maxLength = 8000;
    if (hasInlineImage && replaced.length > maxLength) {
      return `${replaced.slice(0, maxLength)}\n\n[image data truncated while loading]`;
    }

    return hasInlineImage ? replaced : content;
  }, []);

  // Use iOS keyboard fix hook and PWA keyboard handling - must be before function definitions
  const { isKeyboardVisible, keyboardHeight, viewportHeight } = useIOSKeyboardFix();
  const [isInputFocused, setIsInputFocused] = useState(false);

  // Track orientation and device type
  const { isLandscape, isMobile: isMobileDevice, isPWA: isPWAMode } = useOrientation();

  const keyboardOffset = useVisualViewport();
  const isPWA = isPWAMode;

  // Background processing and wake lock management
  const {
    wakeLockActive,
    requestWakeLock,
    releaseWakeLock,
    saveStreamingState,
    getStreamingState,
    clearStreamingState,
  } = useBackgroundProcessing();

  // Create a debounced save function for async updates
  const debouncedSaveConversation = useRef(
    debounce((conversation: Conversation) => {
      saveConversation(conversation);
    }, 1000) // Save at most once per second
  ).current;

  const debouncedSaveConversations = useRef(
    debounce((conversations: Conversation[]) => {
      saveConversations(conversations);
    }, 1000) // Save at most once per second
  ).current;

  const setConversationStreaming = useCallback((conversationId: string, isStreaming: boolean) => {
    if (!conversationId) {
      return;
    }
    const nextStreamingMap = { ...streamingByConversationIdRef.current };
    if (isStreaming) {
      nextStreamingMap[conversationId] = true;
    } else {
      delete nextStreamingMap[conversationId];
    }
    homeDispatch({ field: 'streamingByConversationId', value: nextStreamingMap });
    homeDispatch({ field: 'messageIsStreaming', value: Object.keys(nextStreamingMap).length > 0 });
  }, [homeDispatch]);

  const getOrCreateController = useCallback((conversationId: string) => {
    const existing = controllerByConversationRef.current[conversationId];
    if (existing) {
      return existing;
    }
    const controller = new AbortController();
    controllerByConversationRef.current[conversationId] = controller;
    return controller;
  }, []);

  const resetController = useCallback((conversationId: string) => {
    const controller = new AbortController();
    controllerByConversationRef.current[conversationId] = controller;
    return controller;
  }, []);

  // Async chat for background processing (PWA mode)
  // SECURITY: Memory features require authentication - no 'anon' fallback
  // If user is not authenticated, async chat will not work with memory
  const {
    startAsyncJob,
    jobStatusByConversationId,
    isPolling,
    cancelJob,
    clearPersistedJob,
  } = useAsyncChat({
    userId: user?.username ?? '', // Empty string if not authenticated
    onProgress: (status) => {
      const conversationId = status.conversationId
        || asyncConversationIdRef.current
        || selectedConversationRef.current?.id;
      if (conversationId) {
        const shouldStream = status.status !== 'completed' && status.status !== 'error';
        setConversationStreaming(conversationId, shouldStream);
        asyncConversationIdRef.current = conversationId;
      }
      // Clear the loading flag once the backend is actively processing so the
      // ChatLoader (bouncing dots) hides and the AgentHeartbeat ("Agent is
      // working...") indicator becomes visible.  With NAT async there are no
      // partial text chunks to trigger this transition, so we do it on the
      // first poll that reports 'streaming' (mapped from NAT's 'running').
      if (status.status === 'streaming') {
        homeDispatch({ field: 'loading', value: false });
      }
      // Skip polling UI updates when WS tokens are actively streaming for this conversation
      // (WS provides real-time updates; polling would overwrite with stale snapshots)
      if (conversationId && wsStreamingConversations.current.has(conversationId)) {
        return;
      }

      // Update UI with partial response or intermediate steps using current ref
      const currentConversation = conversationId
        ? conversationsRef.current.find((conversation) => conversation.id === conversationId)
        : selectedConversationRef.current;
      if ((status.partialResponse || status.intermediateSteps?.length) && currentConversation) {
        const safePartialResponse = sanitizeInlineImagesForDisplay(status.partialResponse || '');
        const updatedMessages = [...currentConversation.messages];
        const lastMessage = updatedMessages[updatedMessages.length - 1];

        if (lastMessage && lastMessage.role === 'assistant') {
          // Only overwrite content if we have new content (avoid clobbering WS-accumulated tokens)
          if (safePartialResponse) {
            lastMessage.content = safePartialResponse;
          }
          // Merge intermediate steps to avoid duplicates
          lastMessage.intermediateSteps = mergeIntermediateSteps(
            lastMessage.intermediateSteps || [],
            status.intermediateSteps || [],
            status.status === 'completed' && status.finalizedAt ? status.finalizedAt : undefined
          );
        } else {
          updatedMessages.push({
            role: 'assistant',
            content: safePartialResponse,
            intermediateSteps: status.intermediateSteps || [],
          });
        }

        const updatedConversation = {
          ...currentConversation,
          messages: updatedMessages,
        };

        if (selectedConversationRef.current?.id === currentConversation.id) {
          homeDispatch({
            field: 'selectedConversation',
            value: updatedConversation,
          });
        }

        // Also update the conversations list to keep sidebar in sync
        const currentConversations = conversationsRef.current.map((c) =>
          c.id === currentConversation.id ? updatedConversation : c
        );
        homeDispatch({
          field: 'conversations',
          value: currentConversations,
        });

        // Save conversation state using debounced function
        // debouncedSaveConversation(updatedConversation);
        // debouncedSaveConversations(currentConversations);

        // Periodically save streaming state to IndexedDB for crash recovery (every 2s)
        const now = Date.now();
        if (now - lastStreamingSaveRef.current >= 2000) {
          lastStreamingSaveRef.current = now;
          saveStreamingState({
            isStreaming: true,
            conversationId: conversationId || null,
            partialResponse: status.partialResponse || '',
            timestamp: now,
            intermediateSteps: status.intermediateSteps,
            jobId: status.jobId,
          }).catch(() => {});
        }
      }
    },
    onComplete: async (fullResponse, intermediateSteps, finalizedAt, jobConversationId) => {
      logger.info('Async job completed with full response', { finalizedAt, jobConversationId });

      // Clear IndexedDB streaming state on completion
      clearStreamingState().catch(() => {});

      // Process any base64 images in the response
      const { processMarkdownImages } = await import('@/utils/app/imageHandler');
      const processedResponse = await processMarkdownImages(fullResponse);

      if (processedResponse !== fullResponse) {
        logger.info('Async job: Replaced base64 images with Redis references');
      }

      // Use the job's conversationId (authoritative), falling back to refs only as last resort
      const conversationId = jobConversationId || asyncConversationIdRef.current || selectedConversationRef.current?.id;
      const currentConversation = conversationId
        ? conversationsRef.current.find((conversation) => conversation.id === conversationId)
        : selectedConversationRef.current;
      if (currentConversation) {
        const updatedMessages = [...currentConversation.messages];
        const lastMessage = updatedMessages[updatedMessages.length - 1];

        if (lastMessage && lastMessage.role === 'assistant') {
          lastMessage.content = processedResponse;  // Use processed response
          // Merge intermediate steps to avoid duplicates
          lastMessage.intermediateSteps = mergeIntermediateSteps(
            lastMessage.intermediateSteps || [],
            intermediateSteps || [],
            finalizedAt  // Pass completion timestamp to filter stale steps
          );
        } else {
          updatedMessages.push({
            role: 'assistant',
            content: processedResponse,  // Use processed response
            intermediateSteps: intermediateSteps || [],
          });
        }

        const updatedConversation = {
          ...currentConversation,
          messages: updatedMessages,
        };

        if (selectedConversationRef.current?.id === currentConversation.id) {
          homeDispatch({
            field: 'selectedConversation',
            value: updatedConversation,
          });
        }

        // Save conversation to Redis — skip when the server-side async
        // handler already persisted it (finalizedAt set) to avoid conflicts.
        if (!finalizedAt) {
          try {
            await saveConversation(updatedConversation);
          } catch (error) {
            logger.error('Failed to save conversation', error);
            setTimeout(async () => {
              try {
                await saveConversation(updatedConversation);
              } catch (retryError) {
                logger.error('Retry failed for conversation save', retryError);
                toast.error('Failed to save conversation. Please check your connection.');
              }
            }, 1000);
          }
        }

        // Get the latest conversations from the current state to avoid stale data
        const latestConversations = conversationsRef.current.map((c) =>
          c.id === currentConversation.id ? updatedConversation : c
        );

        homeDispatch({
          field: 'conversations',
          value: latestConversations,
        });

        // Persist the conversation list to Redis so it survives page refresh
        saveConversations(latestConversations).catch((error) => {
          logger.error('Failed to persist conversation list after async job', error);
        });

        // Save conversation state to the conversations API — but skip when
        // the server-side async handler already saved it (finalizedAt is set),
        // to avoid 409 conflict from the duplicate write.
        if (!finalizedAt) {
          try {
            await fetch(`/api/conversations/${currentConversation.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: updatedConversation.messages,
                updatedAt: Date.now(),
              }),
            });
          } catch (error) {
            logger.error('Failed to save conversation to API', error);
          }
        }
      }

      // Notify completion if user is away
      if (isPWA && document.visibilityState !== 'visible') {
        await notifyStreamingComplete(selectedConversationRef.current?.name);
      }

      if (conversationId) {
        setConversationStreaming(conversationId, false);
      }
      homeDispatch({ field: 'loading', value: false });
      if (conversationId) {
        clearPersistedJob(conversationId);
      }
      asyncConversationIdRef.current = null;

      // Release wake lock
      releaseWakeLock();
    },
    onError: async (error, context) => {
      logger.error('Async job error', error, context);

      const conversationId = context?.conversationId
        || asyncConversationIdRef.current
        || selectedConversationRef.current?.id;

      // Recover partial data: prefer server-side context, fall back to IndexedDB
      let partialResponse = context?.partialResponse || '';
      let intermediateSteps = context?.intermediateSteps || [];
      if (!partialResponse) {
        try {
          const saved = await getStreamingState();
          if (saved?.partialResponse) {
            partialResponse = saved.partialResponse;
          }
          if (saved?.intermediateSteps?.length) {
            intermediateSteps = saved.intermediateSteps;
          }
        } catch {
          // IndexedDB unavailable - proceed without
        }
      }

      // Build error metadata for inline display
      const errorMessages = {
        message: error,
        timestamp: Date.now(),
        recoverable: true,
      };

      // Save partial results into the conversation so they're visible to the user
      const currentConversation = conversationId
        ? conversationsRef.current.find((c) => c.id === conversationId)
        : selectedConversationRef.current;

      if (currentConversation) {
        const updatedMessages = [...currentConversation.messages];
        const lastMessage = updatedMessages[updatedMessages.length - 1];

        if (lastMessage && lastMessage.role === 'assistant') {
          // Update existing assistant message with whatever we have
          if (partialResponse && partialResponse.length > (lastMessage.content?.length || 0)) {
            lastMessage.content = partialResponse;
          }
          if (intermediateSteps.length > (lastMessage.intermediateSteps?.length || 0)) {
            lastMessage.intermediateSteps = intermediateSteps;
          }
          lastMessage.errorMessages = errorMessages;
        } else {
          // No assistant message yet - create one with partial data + error
          updatedMessages.push({
            role: 'assistant',
            content: (partialResponse && partialResponse.trim()) || '[Error occurred before response was generated]',
            intermediateSteps,
            errorMessages,
          });
        }

        const updatedConversation = {
          ...currentConversation,
          messages: updatedMessages,
        };

        // Update Redux state so UI renders immediately
        if (selectedConversationRef.current?.id === currentConversation.id) {
          homeDispatch({
            field: 'selectedConversation',
            value: updatedConversation,
          });
        }
        const latestConversations = conversationsRef.current.map((c) =>
          c.id === currentConversation.id ? updatedConversation : c
        );
        homeDispatch({ field: 'conversations', value: latestConversations });

        // Persist locally (server already saved via finalizeError)
        saveConversation(updatedConversation).catch((saveErr) => {
          logger.error('Failed to save partial conversation on error', saveErr);
        });
        saveConversations(latestConversations).catch(() => {});
      } else {
        // No conversation context available - fall back to toast as last resort
        toast.error(`Error: ${error}`);
      }

      // Clear streaming state
      clearStreamingState().catch(() => {});

      if (conversationId) {
        setConversationStreaming(conversationId, false);
      }
      homeDispatch({ field: 'loading', value: false });
      if (conversationId) {
        clearPersistedJob(conversationId);
      }
      asyncConversationIdRef.current = null;

      // Release wake lock on error
      releaseWakeLock();
    },
  });

  // Sync conversation from server when returning from background
  const { syncConversation, syncAfterSend, debouncedSync } = useConversationSync({
    // Enable sync for all users when idle (not streaming/polling)
    // This ensures recovery from network interruptions or tab switches
    enabled: !messageIsStreaming && !isPolling,
    conversationId: selectedConversation?.id,
    minSyncInterval: 5000, // Minimum 5 seconds between syncs
    onConversationUpdated: (serverConversation) => {
      // Guard: only apply if the server conversation still matches the currently selected one.
      // A stale syncAfterSend timeout can fire after the user switched conversations,
      // which would overwrite the current conversation with data from the old one.
      const currentSelectedId = selectedConversationRef.current?.id;
      if (!currentSelectedId || currentSelectedId !== serverConversation.id) {
        return;
      }

      homeDispatch({
        field: 'selectedConversation',
        value: serverConversation
      });

      // Also update the conversations list
      const updatedConversations = conversationsRef.current.map((c) =>
        c.id === serverConversation.id ? serverConversation : c
      );
      homeDispatch({
        field: 'conversations',
        value: updatedConversations
      });

      // Persist to storage (async, best-effort — errors logged but not fatal)
      saveConversation(serverConversation).catch(() => {});
      saveConversations(updatedConversations).catch(() => {});
    }
  });

  // Track which conversations have active WS token streaming
  const wsStreamingConversations = useRef<Set<string>>(new Set());

  // Helper: resolve the current conversation from refs (avoids stale closure)
  const resolveConversation = useCallback((conversationId: string) => {
    if (selectedConversationRef.current?.id === conversationId) {
      return selectedConversationRef.current;
    }
    return conversationsRef.current.find((c) => c.id === conversationId) || null;
  }, []);

  // Helper: dispatch conversation update to state and refs (write-through to prevent stale reads)
  const dispatchConversationUpdate = useCallback((conversationId: string, updatedConversation: Conversation) => {
    const updatedConversations = conversationsRef.current.map((c) =>
      c.id === conversationId ? updatedConversation : c
    );
    // Write-through to refs before dispatch
    conversationsRef.current = updatedConversations;
    if (selectedConversationRef.current?.id === conversationId) {
      selectedConversationRef.current = updatedConversation;
      homeDispatch({ field: 'selectedConversation', value: updatedConversation });
    }
    homeDispatch({ field: 'conversations', value: updatedConversations });
  }, [homeDispatch]);

  // Handle real-time WS token streaming for async jobs
  useEffect(() => {
    const wsManager = getWebSocketManager();
    if (!wsManager.isConnected) return;

    const unsubs: Array<() => void> = [];

    // chat_token: accumulate content token-by-token
    unsubs.push(wsManager.on('chat_token', (data: any) => {
      const conversationId = data.conversationId;
      if (!conversationId) return;
      wsStreamingConversations.current.add(conversationId);

      const currentConversation = resolveConversation(conversationId);
      if (!currentConversation) return;

      const updatedMessages = [...currentConversation.messages];
      const lastMessage = updatedMessages[updatedMessages.length - 1];

      if (lastMessage && lastMessage.role === 'assistant') {
        updatedMessages[updatedMessages.length - 1] = {
          ...lastMessage,
          content: (lastMessage.content || '') + data.content,
        };
      } else {
        updatedMessages.push({ role: 'assistant', content: data.content, intermediateSteps: [] });
      }

      dispatchConversationUpdate(conversationId, { ...currentConversation, messages: updatedMessages });
    }));

    // chat_intermediate_step: append step to last assistant message (or create one)
    unsubs.push(wsManager.on('chat_intermediate_step', (data: any) => {
      const conversationId = data.conversationId;
      if (!conversationId || !data.step) return;
      wsStreamingConversations.current.add(conversationId);

      const currentConversation = resolveConversation(conversationId);
      if (!currentConversation) return;

      const updatedMessages = [...currentConversation.messages];
      const lastMessage = updatedMessages[updatedMessages.length - 1];

      if (lastMessage && lastMessage.role === 'assistant') {
        // Deduplicate by UUID
        const existing = lastMessage.intermediateSteps || [];
        const uuid = data.step?.payload?.UUID;
        if (uuid && existing.some((s: any) => s.payload?.UUID === uuid)) return;
        updatedMessages[updatedMessages.length - 1] = {
          ...lastMessage,
          intermediateSteps: [...existing, data.step],
        };
      } else {
        // Create assistant message with empty content for intermediate steps
        // (steps arrive BEFORE content tokens — agent runs tools first)
        updatedMessages.push({ role: 'assistant', content: '', intermediateSteps: [data.step] });
      }

      dispatchConversationUpdate(conversationId, { ...currentConversation, messages: updatedMessages });
    }));

    // chat_complete: finalize with full response, unsubscribe
    unsubs.push(wsManager.on('chat_complete', (data: any) => {
      const conversationId = data.conversationId;
      if (!conversationId) return;

      wsManager.unsubscribeFromChat(conversationId);
      wsStreamingConversations.current.delete(conversationId);

      const currentConversation = resolveConversation(conversationId);
      if (!currentConversation) return;

      const updatedMessages = [...currentConversation.messages];
      const lastMessage = updatedMessages[updatedMessages.length - 1];

      if (lastMessage && lastMessage.role === 'assistant') {
        updatedMessages[updatedMessages.length - 1] = {
          ...lastMessage,
          content: data.fullResponse || lastMessage.content,
          intermediateSteps: data.intermediateSteps || lastMessage.intermediateSteps,
        };
      } else {
        updatedMessages.push({
          role: 'assistant',
          content: data.fullResponse || '',
          intermediateSteps: data.intermediateSteps || [],
        });
      }

      dispatchConversationUpdate(conversationId, { ...currentConversation, messages: updatedMessages });
    }));

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Recover from interrupted streaming on mount
  useEffect(() => {
    const recover = async () => {
      try {
        const saved = await getStreamingState();
        if (!saved || !saved.isStreaming || !saved.jobId) return;
        // Only recover if the state is recent (< 15 minutes)
        if (Date.now() - saved.timestamp > 15 * 60 * 1000) {
          await clearStreamingState();
          return;
        }
        logger.info('Recovering interrupted streaming', { jobId: saved.jobId, conversationId: saved.conversationId });
        // Poll the async job for the final result
        try {
          const res = await fetch(`/api/chat/async?jobId=${encodeURIComponent(saved.jobId)}`);
          if (res.ok) {
            const jobStatus = await res.json();
            if (jobStatus.status === 'completed' && saved.conversationId) {
              // Sync conversation from server
              const convRes = await fetch(`/api/conversations/${saved.conversationId}`);
              if (convRes.ok) {
                const conv = await convRes.json();
                homeDispatch({ field: 'selectedConversation', value: conv });
              }
            }
          }
        } catch {
          // Recovery is best-effort
        }
        await clearStreamingState();
      } catch {
        // IndexedDB may not be ready yet
      }
    };
    recover();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Request notification permission on mount for PWA background processing
  useEffect(() => {
    if (isPWA) {
      requestNotificationPermission().then(permission => {
        if (permission === 'granted') {
          logger.info('Notification permission granted for background processing');
        } else {
          logger.info('Notification permission denied - user will not receive completion alerts');
        }
      });
    }
  }, [isPWA]);

  // Ensure saves are flushed when the window is about to unload
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Flush any pending saves
      debouncedSaveConversation.flush();
      debouncedSaveConversations.flush();

      // If there are unsaved changes and streaming is active, warn the user
      if (messageIsStreaming) {
        e.preventDefault();
        e.returnValue = 'You have an active conversation. Are you sure you want to leave?';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [messageIsStreaming, debouncedSaveConversation, debouncedSaveConversations]);

  // Comprehensive visibility change handler for state recovery
  useEffect(() => {
    if (!isPWA || !enableBackgroundProcessing) return;

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        logger.info('App became visible - checking for background updates');

        // 1. Check for any active async jobs
        const selectedJobStatus = selectedConversation?.id
          ? jobStatusByConversationId[selectedConversation.id]
          : undefined;
        if (isPolling && selectedJobStatus) {
          logger.info(`Active job detected: ${selectedJobStatus.jobId}`);
          // The useAsyncChat hook will handle resuming polling
        }

        // 2. Force sync conversation from server
        if (selectedConversation?.id && syncConversation) {
          logger.info(`Syncing conversation from server: ${selectedConversation.id}`);
          await syncConversation();
        }

        // 3. Check for any missed notifications
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          // Request any pending updates from service worker
          navigator.serviceWorker.controller.postMessage({
            type: 'CHECK_PENDING_UPDATES',
            conversationId: selectedConversation?.id,
          });
        }
      } else {
        logger.info('App went to background');

        // Save current state to ensure recovery
        if (selectedConversation && messageIsStreaming) {
          logger.info('Saving streaming state for background recovery');
          // The async job will continue processing in the background
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Also handle focus events as a backup
    const handleFocus = () => {
      if (document.visibilityState === 'visible') {
        handleVisibilityChange();
      }
    };

    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      // Cancel any pending syncs
      // syncConversation might return a promise with abort capability in the future
    };
  }, [isPWA, enableBackgroundProcessing, selectedConversation, syncConversation, isPolling, jobStatusByConversationId, messageIsStreaming]);


  // Helper function to extract first few words from user's message for conversation name
  const getConversationNameFromMessage = useCallback((content: string, maxWords: number = 6): string => {
    if (!content || typeof content !== 'string') {
      return 'New Conversation';
    }

    // Remove markdown formatting, extra whitespace, and newlines
    const cleaned = content
      .replace(/[#*_`\[\]()]/g, '') // Remove markdown characters
      .replace(/\n+/g, ' ') // Replace newlines with spaces
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();

    // Split into words and take first few words
    const words = cleaned.split(/\s+/).filter(word => word.length > 0);

    if (words.length === 0) {
      return 'New Conversation';
    }

    // Take first maxWords words, or all words if less than maxWords
    const selectedWords = words.slice(0, maxWords);
    const name = selectedWords.join(' ');

    // Add ellipsis if we truncated
    return words.length > maxWords ? name + '...' : name;
  }, []);

  const mergeIntermediateSteps = useCallback(
    (
      existingSteps: IntermediateStep[] = [],
      incomingSteps: IntermediateStep[] = [],
      completionTimestamp?: number,  // Optional timestamp when job was finalized
    ): IntermediateStep[] => {
      if (!incomingSteps.length) {
        return existingSteps;
      }

      const stepsById = new Map<string, IntermediateStep>();

      existingSteps.forEach((step) => {
        if (step?.payload?.UUID) {
          stepsById.set(step.payload.UUID, step);
        }
      });

      incomingSteps.forEach((step) => {
        const uuid = step?.payload?.UUID;
        if (!uuid) {
          return;
        }

        // Filter out steps that were created after job completion
        // This prevents stale steps from appearing after the response is done
        if (completionTimestamp && step.payload.event_timestamp) {
          // Convert completion timestamp from milliseconds to seconds to match event_timestamp
          const completionTimestampSeconds = completionTimestamp / 1000;
          if (step.payload.event_timestamp > completionTimestampSeconds) {
            logger.warn(`Filtering out stale intermediate step created after completion`, {
              stepName: step.payload.name,
              stepTimestamp: step.payload.event_timestamp,
              completionTimestamp: completionTimestampSeconds,
            });
            return;  // Skip this step
          }
        }

        const current = stepsById.get(uuid);
        if (current) {
          // More aggressive deduplication - only update if the incoming step has newer data
          const shouldUpdate = !current.payload.event_timestamp ||
            (step.payload.event_timestamp &&
              step.payload.event_timestamp >= current.payload.event_timestamp);

          if (shouldUpdate) {
            stepsById.set(uuid, {
              ...current,
              ...step,
              function_ancestry: step.function_ancestry || current.function_ancestry,
              payload: {
                ...current.payload,
                ...step.payload,
                span_event_timestamp:
                  step.payload.span_event_timestamp ?? current.payload.span_event_timestamp,
                metadata: step.payload.metadata ?? current.payload.metadata,
                data: step.payload.data ?? current.payload.data,
                usage_info: step.payload.usage_info ?? current.payload.usage_info,
              },
            });
          }
        } else {
          stepsById.set(uuid, step);
        }
      });

      return Array.from(stepsById.values()).sort(
        (a, b) => a.payload.event_timestamp - b.payload.event_timestamp,
      );
    },
    [],
  );

  const handleSend = useCallback(
    async (message: Message, deleteCount = 0, retry = false) => {
      message.id = uuidv4();
      // chat with bot
      const getLatestConversationSnapshot = () => {
        const currentConversation = selectedConversationRef.current ?? selectedConversation;
        const storedConversation = getUserSessionItem('selectedConversation');
        if (!storedConversation || !currentConversation) {
          return currentConversation;
        }
        try {
          const parsed = JSON.parse(storedConversation) as Conversation;
          if (parsed?.id === currentConversation.id && Array.isArray(parsed.messages)) {
            if (parsed.messages.length > (currentConversation.messages?.length || 0)) {
              return parsed;
            }
          }
        } catch (error) {
          logger.warn('Failed to parse selectedConversation from storage', error);
        }
        return currentConversation;
      };

      const activeConversation = getLatestConversationSnapshot();

      if (activeConversation) {
        const conversationId = activeConversation.id;
        asyncConversationIdRef.current = conversationId;
        setConversationStreaming(conversationId, true);
        // Check if we should use async mode (PWA for background processing)
        const useAsyncMode = isPWA;
        logger.info('Mode Check', {
          isPWA,
          enableBackgroundProcessing,
          willUseAsync: isPWA && enableBackgroundProcessing,
          displayMode: window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser',
          navigatorStandalone: (window.navigator as any).standalone
        });
        let updatedConversation: Conversation;
        if (deleteCount) {
          const updatedMessages = [...activeConversation.messages];
          for (let i = 0; i < deleteCount; i++) {
            updatedMessages.pop();
          }
          updatedConversation = {
            ...activeConversation,
            messages: [...updatedMessages, message],
          };
        } else {
          // Process message to store images in Redis if needed
          const processedMessage = await processMessageImages(message);
          updatedConversation = {
            ...activeConversation,
            messages: [
              ...activeConversation.messages,
              processedMessage,
            ],
          };
        }

        // Set conversation name based on first few words from user's message
        // Only update if name is still the default "New Conversation" or if this is the first user message
        const isDefaultName = !updatedConversation.name ||
          updatedConversation.name === 'New Conversation' ||
          updatedConversation.name === t('New Conversation');
        const isFirstUserMessage = updatedConversation.messages.filter(m => m.role === 'user').length === 1;

        if (isDefaultName && isFirstUserMessage) {
          const { content } = message;
          const customName = getConversationNameFromMessage(content);
          updatedConversation = {
            ...updatedConversation,
            name: customName,
          };
        }

        homeDispatch({
          field: 'selectedConversation',
          value: updatedConversation,
        });

        homeDispatch({ field: 'loading', value: true });
        setConversationStreaming(activeConversation.id, true);

        // Request wake lock for streaming (only if enabled and not in async mode)
        if (enableBackgroundProcessing && !isPWA) {
          requestWakeLock();
        }

        // Store processed conversation
        saveConversation(updatedConversation);
        // Check if the conversation exists in the list
        const conversationExists = conversationsRef.current.some(
          (conversation) => conversation.id === activeConversation.id
        );

        let updatedConversations: Conversation[];
        if (conversationExists) {
          // Update existing conversation
          updatedConversations = conversationsRef.current.map(
            (conversation) => {
              if (conversation.id === activeConversation.id) {
                return updatedConversation;
              }
              return conversation;
            },
          );
        } else {
          // Add new conversation to the list
          updatedConversations = [...conversations, updatedConversation];
        }
        homeDispatch({
          field: 'conversations',
          value: updatedConversations,
        });
        saveConversations(updatedConversations);

        // cleaning up messages to fit the request payload and remove image data
        const messagesCleaned = cleanMessagesForLLM(updatedConversation.messages);

        // Format current date for injection
        const now = new Date();
        const monthNames = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"];
        const day = now.getDate();
        const daySuffix = (day: number) => {
          if (day > 3 && day < 21) return 'th';
          switch (day % 10) {
            case 1: return 'st';
            case 2: return 'nd';
            case 3: return 'rd';
            default: return 'th';
          }
        };
        const formattedDate = `${monthNames[now.getMonth()]} ${day}${daySuffix(day)}, ${now.getFullYear()}`;

        // Always inject date into the last user message
        // const lastMessage = messagesCleaned[messagesCleaned.length - 1];
        // if (lastMessage?.role === 'user') {
        //   lastMessage.content = `${lastMessage.content}`;
        //   // Append Deep Thinker workflow instructions only if the metadata flag is set
        //   if ((lastMessage as any).metadata?.useDeepThinker) {
        //     lastMessage.content = `${lastMessage.content}\n\nToday is ${formattedDate}.\n\nDEEP RESEARCH NEEDED: You must follow the researcher workflow: query_writer_researcher → execute research with available tools → summarizer_researcher → report_extender_researcher → reflection_researcher → finalize_report_researcher.`;
        //   }
        // }

        // SECURITY: Memory/personalization features require authentication
        // If user is not authenticated, username will be empty and memory features will be disabled
        const usernameForMemory = user?.username ?? '';

        // Strip any prior system messages — the backend's NAT agent owns the
        // system prompt.  Sending a second system-role message causes a 400
        // from LLMs that only allow one (e.g. Qwen).
        const nonSystemMessages = messagesCleaned.filter(
          (m: Message) => m.role !== 'system',
        );

        const chatBody: ChatBody = {
          messages: nonSystemMessages,
          // Use user-specific storage key to prevent data leakage between users
          chatCompletionURL: getUserSessionItem('chatCompletionURL') || chatCompletionURL,
          additionalProps: {
            enableIntermediateSteps: getUserSessionItem('enableIntermediateSteps')
              ? getUserSessionItem('enableIntermediateSteps') === 'true'
              : enableIntermediateSteps,
            // SECURITY: No 'anon' fallback - memory features require authentication
            username: usernameForMemory,
            useDeepThinker: useDeepThinker,
            // Enhanced user context for Redis memory (only populated if authenticated)
            userContext: usernameForMemory ? {
              id: user?.id || null,
              username: usernameForMemory,
              name: user?.name || null,
              conversationId,
              sessionTimestamp: Date.now(),
            } : undefined
          }
        };

        // Use async mode if enabled in settings and user is in PWA
        if (useAsyncMode && enableBackgroundProcessing) {
          logger.info('Using ASYNC mode for background processing (job-based)');

          try {
            // Subscribe to WS token channel BEFORE starting job to avoid missing early tokens
            const wsManager = getWebSocketManager();
            if (wsManager.isConnected) {
              wsManager.subscribeToChat(conversationId);
              logger.info('Subscribed to WS chat token channel for real-time streaming');
            }

            await startAsyncJob(
              chatBody.messages || [],
              chatBody.chatCompletionURL || '',
              chatBody.additionalProps || {},
              usernameForMemory, // SECURITY: Empty string if not authenticated
              conversationId,
              updatedConversation.name
            );
            logger.info('Async job started - will poll for results');

            // Trigger sync after sending message to catch the response
            syncAfterSend();
          } catch (error: any) {
            logger.error('Failed to start async job', error);

            // Show inline error instead of ephemeral toast
            const errorMsg = error?.message || 'Failed to start request';
            const msgs = [...updatedConversation.messages];
            msgs.push({ role: 'assistant', content: '', errorMessages: { message: errorMsg, timestamp: Date.now(), recoverable: true } });
            updatedConversation = { ...updatedConversation, messages: msgs };
            homeDispatch({ field: 'selectedConversation', value: updatedConversation });
            homeDispatch({ field: 'conversations', value: conversationsRef.current.map((c) => c.id === updatedConversation.id ? updatedConversation : c) });
            saveConversation(updatedConversation);

            homeDispatch({ field: 'loading', value: false });
            setConversationStreaming(conversationId, false);
            asyncConversationIdRef.current = null;
          }
          return; // Exit early for async mode
        }

        // Standard streaming mode (browser/non-PWA)
        logger.info('Using STREAMING mode (SSE - requires active connection)');
        if (!useAsyncMode) {
          logger.debug('Reason: Not installed as PWA - use "Add to Home Screen"');
        } else if (!enableBackgroundProcessing) {
          logger.debug('Reason: Background processing disabled - enable in Settings');
        }
        const endpoint = getEndpoint({ service: 'chat' });
        let body;
        body = JSON.stringify({
          ...chatBody,
        });

        const streamConversationId = conversationId;
        const currentGeneration = (streamGenerationRef.current[streamConversationId] ?? 0) + 1;
        streamGenerationRef.current[streamConversationId] = currentGeneration;
        const controller = getOrCreateController(streamConversationId);
        let response;
        try {
          logger.info('sending chat request payload', {
            endpoint,
            messageCount: messagesCleaned.length,
          });
          response = await fetch(`${endpoint}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            signal: controller.signal, // Use per-conversation controller
            body,
          });

          if (!response?.ok) {
            homeDispatch({ field: 'loading', value: false });
            setConversationStreaming(streamConversationId, false);
            // Add inline error to the conversation instead of ephemeral toast
            const errorMsg = response.statusText || 'Server returned an error';
            const msgs = [...updatedConversation.messages];
            msgs.push({ role: 'assistant', content: '', errorMessages: { message: errorMsg, timestamp: Date.now(), recoverable: true } });
            updatedConversation = { ...updatedConversation, messages: msgs };
            homeDispatch({ field: 'selectedConversation', value: updatedConversation });
            homeDispatch({ field: 'conversations', value: conversationsRef.current.map((c) => c.id === updatedConversation.id ? updatedConversation : c) });
            saveConversation(updatedConversation);
            return;
          }

          const data = response?.body;
          if (!data) {
            homeDispatch({ field: 'loading', value: false });
            setConversationStreaming(streamConversationId, false);
            const msgs = [...updatedConversation.messages];
            msgs.push({ role: 'assistant', content: '', errorMessages: { message: 'No data received from server', timestamp: Date.now(), recoverable: true } });
            updatedConversation = { ...updatedConversation, messages: msgs };
            homeDispatch({ field: 'selectedConversation', value: updatedConversation });
            homeDispatch({ field: 'conversations', value: conversationsRef.current.map((c) => c.id === updatedConversation.id ? updatedConversation : c) });
            saveConversation(updatedConversation);
            return;
          }
          {
            const reader = data.getReader();
            streamReaderByConversationRef.current[streamConversationId] = reader;
            const decoder = new TextDecoder();
            let done = false;
            let isFirst = true;
            let rawText = '';
            let displayText = '';
            let counter = 1;
            let intermediateStepBuffer = ''; // Buffer for accumulating partial intermediate steps
            let loadingCleared = false; // Track when loading is cleared so it fires on first real text chunk, not first chunk
            setCurrentActivityText('');
            setCompletedStepCategories([]);
            while (!done) {
              // Check if the request was aborted before reading
              if (controller.signal.aborted) {
                reader.cancel();
                done = true;
                break;
              }

              let readResult;
              try {
                readResult = await reader.read();
              } catch (readError: any) {
                // If reader was cancelled or aborted, break the loop
                if (readError?.name === 'AbortError' || controller.signal.aborted) {
                  done = true;
                  break;
                }
                throw readError; // Re-throw if it's a different error
              }

              const { value, done: doneReading } = readResult;
              done = doneReading;

              // If stream is done or value is undefined, break
              if (done || !value) {
                break;
              }

              let chunkValue = decoder.decode(value);
              counter++;

              // Add current chunk to any buffered content
              chunkValue = intermediateStepBuffer + chunkValue;
              intermediateStepBuffer = '';

              // Detect SSE completion signal even if the stream stays open
              // This prevents the UI from staying in "Typing..." indefinitely.
              // Note: Don't use /g flag with .test() as it creates stateful regex
              // that can fail on subsequent calls due to lastIndex advancement
              const hasDoneSignal = /data:\s*\[DONE\]/.test(chunkValue);
              if (hasDoneSignal) {
                chunkValue = chunkValue.replace(/data:\s*\[DONE\]/g, '');
                done = true;
              }

              // Check if we have an incomplete intermediate step at the end
              const lastOpenTag = chunkValue.lastIndexOf('<intermediatestep>');
              const lastCloseTag = chunkValue.lastIndexOf('</intermediatestep>');

              if (lastOpenTag > lastCloseTag) {
                // We have an incomplete tag, buffer it for next iteration
                intermediateStepBuffer = chunkValue.substring(lastOpenTag);
                chunkValue = chunkValue.substring(0, lastOpenTag);
              }

              // Process complete intermediate steps
              let rawIntermediateSteps: IntermediateStep[] = [];
              let messages = chunkValue.match(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g) || [];
              for (const message of messages) {
                try {
                  const jsonString = message.replace('<intermediatestep>', '').replace('</intermediatestep>', '').trim();
                  let rawIntermediateMessage = JSON.parse(jsonString);
                  // Check if it's already in new format
                  if (rawIntermediateMessage?.payload?.event_type) {
                    rawIntermediateSteps.push(rawIntermediateMessage as IntermediateStep);
                  }
                  // Handle old format (for backward compatibility)
                  else if (rawIntermediateMessage?.type === 'system_intermediate') {
                    // Transform old format to new format
                    const newFormatStep: IntermediateStep = {
                      parent_id: rawIntermediateMessage.parent_id || 'root',
                      function_ancestry: {
                        node_id: rawIntermediateMessage.id || `step-${Date.now()}`,
                        parent_id: rawIntermediateMessage.parent_id || null,
                        function_name: rawIntermediateMessage.content?.name || 'Unknown',
                        depth: 0
                      },
                      payload: {
                        event_type: rawIntermediateMessage.status === 'completed' ? IntermediateStepType.CUSTOM_END : IntermediateStepType.CUSTOM_START,
                        event_timestamp: rawIntermediateMessage.time_stamp || Date.now() / 1000,
                        name: rawIntermediateMessage.content?.name || 'Step',
                        metadata: {
                          original_data: rawIntermediateMessage
                        },
                        data: {
                          output: rawIntermediateMessage.content?.payload || ''
                        },
                        UUID: rawIntermediateMessage.id || `${Date.now()}-${Math.random()}`
                      }
                    };
                    rawIntermediateSteps.push(newFormatStep);
                  }
                } catch (error) {
                  logger.error('Failed to parse intermediate step JSON', error);
                  // Still continue - we'll remove the tags below to prevent raw display
                }
              }

              rawIntermediateSteps = rawIntermediateSteps.filter((step) => {
                if (!step?.payload?.event_type) {
                  return false;
                }
                return getEventState(step.payload.event_type) !== IntermediateStepState.CHUNK;
              });

              // Update live activity status from incoming steps
              for (const step of rawIntermediateSteps) {
                const actText = stepToActivityText(step);
                if (actText) setCurrentActivityText(actText);
                if (getEventState(step.payload.event_type) === IntermediateStepState.END) {
                  const cat = getEventCategory(step.payload.event_type);
                  if (cat === IntermediateStepCategory.LLM || cat === IntermediateStepCategory.TOOL) {
                    setCompletedStepCategories(prev => [...prev, cat]);
                  }
                }
              }

              // ALWAYS remove intermediate step tags from visible content, even if parsing failed
              // This prevents raw JSON from being displayed to users
              chunkValue = chunkValue.replace(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g, '');

              rawText = rawText + chunkValue;
              displayText = sanitizeInlineImagesForDisplay(rawText);

              // Only hide the loader once real text content arrives, so the ChatLoader
              // stays visible during intermediate-step-only chunks. Using a separate
              // loadingCleared flag (not isFirst) because isFirst becomes false after
              // the first chunk regardless of whether it contained real text.
              if (!loadingCleared && displayText.trim()) {
                loadingCleared = true;
                homeDispatch({ field: 'loading', value: false });
              }

              const updatedMessages: Message[] = isFirst
                ? [
                  ...updatedConversation.messages,
                  {
                    role: 'assistant',
                    content: displayText,
                    intermediateSteps: mergeIntermediateSteps(
                      [],
                      rawIntermediateSteps,
                      undefined  // No completion timestamp during streaming
                    ),
                  },
                ]
                : updatedConversation.messages.map((message, index) => {
                  if (index === updatedConversation.messages.length - 1) {
                    return {
                      ...message,
                      content: displayText,
                      intermediateSteps: mergeIntermediateSteps(
                        message?.intermediateSteps,
                        rawIntermediateSteps,
                        undefined  // No completion timestamp during streaming
                      ),
                    };
                  }
                  return message;
                });

              isFirst = false;

              updatedConversation = {
                ...updatedConversation,
                messages: updatedMessages,
              };

              if (selectedConversationRef.current?.id === streamConversationId) {
                homeDispatch({
                  field: 'selectedConversation',
                  value: updatedConversation,
                });
              }
              const streamingConversations = conversationsRef.current.map((conversation) =>
                conversation.id === streamConversationId ? updatedConversation : conversation
              );
              homeDispatch({
                field: 'conversations',
                value: streamingConversations,
              });
              debouncedSaveConversation(updatedConversation);
              debouncedSaveConversations(streamingConversations);
            }

            // Clear loading and activity state immediately once the stream loop exits.
            // If loading was already cleared on first text chunk, these are no-ops.
            homeDispatch({ field: 'loading', value: false });
            setCurrentActivityText('');

            if (done) {
              try {
                await reader.cancel();
              } catch (cancelError) {
                // Ignore cancellation errors - stream may already be closed
              }

              // If the message content is empty but we have intermediate steps,
              // extract the final response from the last END event
              const lastMsg = updatedConversation.messages[updatedConversation.messages.length - 1];
              if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.content?.trim() && lastMsg.intermediateSteps?.length) {
                logger.debug('Empty response detected, attempting to extract from intermediate steps', {
                  stepCount: lastMsg.intermediateSteps.length,
                  stepTypes: lastMsg.intermediateSteps.map(s => s?.payload?.event_type)
                });

                const endEventTypes = [
                  IntermediateStepType.LLM_END,
                  IntermediateStepType.TOOL_END,
                  IntermediateStepType.WORKFLOW_END,
                  IntermediateStepType.TASK_END,
                  IntermediateStepType.FUNCTION_END,
                  IntermediateStepType.CUSTOM_END,
                ];

                // Find the last END event with output content
                const steps = lastMsg.intermediateSteps;
                let extractedContent = '';
                let extractionSource = '';

                // Enhanced extraction logic with multiple fallback paths
                for (let i = steps.length - 1; i >= 0; i--) {
                  const step = steps[i];
                  if (endEventTypes.includes(step?.payload?.event_type)) {
                    // Strategy 0 (NAT v1.6.0+): data.output is the full markdown
                    // payload from intermediate_data. Extract just the function output.
                    const rawOutput = step?.payload?.data?.output;
                    if (rawOutput && typeof rawOutput === 'string') {
                      // Try **Function Output:** (function events) then **Output:** (tool events)
                      for (const marker of ['**Function Output:**\n```', '**Output:**\n```']) {
                        const mIdx = rawOutput.lastIndexOf(marker);
                        if (mIdx !== -1) {
                          const nlAfterFence = rawOutput.indexOf('\n', mIdx + marker.length);
                          if (nlAfterFence !== -1) {
                            let clean = rawOutput.slice(nlAfterFence + 1);
                            const closeFence = clean.lastIndexOf('\n```');
                            if (closeFence !== -1) clean = clean.slice(0, closeFence);
                            if (clean.trim() && clean.trim() !== '[]') {
                              extractedContent = clean.trim();
                              extractionSource = 'intermediate_data.function_output';
                              logger.debug('Extracted function output from intermediate_data payload', {
                                eventType: step.payload.event_type,
                                outputLength: extractedContent.length,
                              });
                              break;
                            }
                          }
                        }
                      }
                      if (extractedContent) break;
                    }

                    // Strategy 1: Check data.output (plain string, not markdown)
                    const output = step?.payload?.data?.output;
                    if (output && typeof output === 'string' && output.trim()
                        && !output.includes('**Function Input:**') && !output.includes('**Input:**')) {
                      extractedContent = output;
                      extractionSource = 'data.output';
                      logger.debug('Extracted final response from intermediate step data.output', {
                        eventType: step.payload.event_type,
                        outputLength: output.length,
                      });
                      break;
                    }

                    // Strategy 2: Check metadata.chat_responses for LLM_END events
                    const chatResponse = step?.payload?.metadata?.chat_responses;
                    if (chatResponse && typeof chatResponse === 'string' && chatResponse.trim()) {
                      extractedContent = chatResponse;
                      extractionSource = 'metadata.chat_responses';
                      logger.debug('Extracted final response from intermediate step chat_responses', {
                        eventType: step.payload.event_type,
                        outputLength: chatResponse.length,
                      });
                      break;
                    }

                    // Strategy 3: Check for response in data.result
                    const result = step?.payload?.data?.result;
                    if (result && typeof result === 'string' && result.trim()) {
                      extractedContent = result;
                      extractionSource = 'data.result';
                      logger.debug('Extracted final response from intermediate step data.result', {
                        eventType: step.payload.event_type,
                        outputLength: result.length,
                      });
                      break;
                    }

                    // Strategy 4: Check for response in data.content
                    const content = step?.payload?.data?.content;
                    if (content && typeof content === 'string' && content.trim()) {
                      extractedContent = content;
                      extractionSource = 'data.content';
                      logger.debug('Extracted final response from intermediate step data.content', {
                        eventType: step.payload.event_type,
                        outputLength: content.length,
                      });
                      break;
                    }

                    // Strategy 5: Check for nested response structures
                    const nestedResponse = step?.payload?.data?.response?.content || step?.payload?.data?.response?.text;
                    if (nestedResponse && typeof nestedResponse === 'string' && nestedResponse.trim()) {
                      extractedContent = nestedResponse;
                      extractionSource = 'data.response.content/text';
                      logger.debug('Extracted final response from nested response structure', {
                        eventType: step.payload.event_type,
                        outputLength: nestedResponse.length,
                      });
                      break;
                    }

                    // Log available keys for this step if no extraction worked
                    logger.debug('No extractable content found in END step', {
                      eventType: step.payload.event_type,
                      availableDataKeys: step?.payload?.data ? Object.keys(step.payload.data) : [],
                      availableMetadataKeys: step?.payload?.metadata ? Object.keys(step.payload.metadata) : [],
                      stepIndex: i
                    });
                  }
                }

                // Fallback: Try to extract from any step (not just END events) if nothing found
                if (!extractedContent) {
                  logger.debug('No content in END events, checking all intermediate steps...');
                  for (let i = steps.length - 1; i >= 0; i--) {
                    const step = steps[i];
                    if (step?.payload?.data) {
                      // Check common response fields
                      const possibleContent =
                        step.payload.data.output ||
                        step.payload.data.result ||
                        step.payload.data.content ||
                        step.payload.data.response?.content ||
                        step.payload.data.response?.text ||
                        step.payload.metadata?.chat_responses;

                      if (possibleContent && typeof possibleContent === 'string' && possibleContent.trim()) {
                        extractedContent = possibleContent;
                        extractionSource = `fallback-step-${i}`;
                        logger.debug('Fallback extraction successful from any step', {
                          eventType: step.payload.event_type,
                          outputLength: possibleContent.length,
                          stepIndex: i
                        });
                        break;
                      }
                    }
                  }
                }

                // Update conversation with extracted content
                if (extractedContent) {
                  rawText = extractedContent;
                  displayText = extractedContent;

                  const updatedMsgWithContent = { ...lastMsg, content: extractedContent };
                  const messagesWithExtracted = [
                    ...updatedConversation.messages.slice(0, -1),
                    updatedMsgWithContent
                  ];

                  updatedConversation = {
                    ...updatedConversation,
                    messages: messagesWithExtracted,
                  };

                  logger.info('Successfully recovered empty response using extraction strategy', { extractionSource });

                  // Update UI state immediately
                  if (selectedConversationRef.current?.id === streamConversationId) {
                    homeDispatch({
                      field: 'selectedConversation',
                      value: updatedConversation,
                    });
                  }
                } else {
                  logger.warn('Failed to extract any content from intermediate steps', {
                    stepCount: steps.length,
                    stepTypes: steps.map(s => s?.payload?.event_type),
                    availableStepData: steps.map((s, i) => ({
                      index: i,
                      eventType: s?.payload?.event_type,
                      hasData: !!s?.payload?.data,
                      dataKeys: s?.payload?.data ? Object.keys(s.payload.data) : [],
                      hasMetadata: !!s?.payload?.metadata,
                      metadataKeys: s?.payload?.metadata ? Object.keys(s.payload.metadata) : []
                    }))
                  });
                }
              }
            }

            // Process any base64 images in the assistant's message content
            // This happens after streaming is complete
            let lastMessage = updatedConversation.messages[updatedConversation.messages.length - 1];
            if (lastMessage && lastMessage.role === 'assistant') {
              let contentChanged = false;
              let currentContent = lastMessage.content || '';

              // Extract image references from intermediate steps (TOOL_END events)
              // The LLM may not include tool-generated image markdown in its response
              if (lastMessage.intermediateSteps?.length) {
                const imageRefPattern = /!\[[^\]]*\]\(\/api\/generated-image\/[a-f0-9-]+\)/g;
                const missingImageRefs: string[] = [];

                for (const step of lastMessage.intermediateSteps) {
                  // Check all possible locations for image references in step data
                  const candidates = [
                    step?.payload?.data?.output,
                    step?.payload?.data?.content,
                    step?.payload?.data?.result,
                    step?.payload?.metadata?.tool_outputs,
                    step?.payload?.metadata?.chat_responses,
                  ];

                  // Also check original_payload from system_intermediate events
                  const origPayload = step?.payload?.metadata?.original_payload;
                  if (origPayload) {
                    candidates.push(origPayload?.payload, origPayload?.message, origPayload?.content);
                  }

                  for (const candidate of candidates) {
                    if (typeof candidate === 'string') {
                      const matches = candidate.match(imageRefPattern);
                      if (matches) {
                        for (const match of matches) {
                          if (!currentContent.includes(match) && !missingImageRefs.includes(match)) {
                            missingImageRefs.push(match);
                          }
                        }
                      }
                    }
                  }
                }

                if (missingImageRefs.length > 0) {
                  currentContent = currentContent + '\n\n' + missingImageRefs.join('\n\n');
                  contentChanged = true;
                  logger.info('Injected missing image reference(s) from intermediate steps', {
                    count: missingImageRefs.length,
                  });
                }
              }

              // Process any base64 images (replace with Redis references)
              if (currentContent) {
                const { processMarkdownImages } = await import('@/utils/app/imageHandler');
                const processedContent = await processMarkdownImages(currentContent);

                if (processedContent !== currentContent) {
                  currentContent = processedContent;
                  contentChanged = true;
                  logger.info('Image processing: Replaced base64 images with Redis references');
                }
              }

              if (contentChanged) {
                // Create NEW message and conversation objects to trigger React re-render
                const updatedMessage = { ...lastMessage, content: currentContent };
                const updatedMessages = [
                  ...updatedConversation.messages.slice(0, -1),
                  updatedMessage
                ];

                updatedConversation = {
                  ...updatedConversation,
                  messages: updatedMessages,
                };

                // Update the conversation state to trigger re-render
                if (selectedConversationRef.current?.id === streamConversationId) {
                  homeDispatch({
                    field: 'selectedConversation',
                    value: updatedConversation,
                  });
                }

                logger.info('Updated conversation with processed images');
              } else {
                logger.debug('No image processing needed for response');
              }
            }

            // Save conversation AFTER image processing
            saveConversation(updatedConversation);

            // Check if the conversation exists in the list
            const conversationExists = conversationsRef.current.some(
              (conversation) => conversation.id === updatedConversation.id
            );

            let updatedConversations: Conversation[];
            if (conversationExists) {
              // Update existing conversation with the PROCESSED version
              updatedConversations = conversationsRef.current.map(
                (conversation) => {
                  if (conversation.id === updatedConversation.id) {
                    return updatedConversation; // This now includes processed images
                  }
                  return conversation;
                },
              );
            } else {
              // Add new conversation to the list
              updatedConversations = [...conversations, updatedConversation];
            }

            homeDispatch({
              field: 'conversations',
              value: updatedConversations,
            });
            saveConversations(updatedConversations);

            // Notify user that response is complete if they're away
            if (isPWA && document.visibilityState !== 'visible') {
              await notifyStreamingComplete(updatedConversation.name);
            }

            // Clear reader reference after streaming completes
            streamReaderByConversationRef.current[streamConversationId] = null;
            asyncConversationIdRef.current = null;

            // Yield to let final UI render settle before clearing streaming state.
            // Guard with generation counter so a new stream isn't cancelled by stale cleanup.
            setTimeout(() => {
              if (streamGenerationRef.current[streamConversationId] === currentGeneration) {
                setConversationStreaming(streamConversationId, false);
                homeDispatch({ field: 'loading', value: false });
                releaseWakeLock();
              }
            }, 0);
          }
        } catch (error: any) {
          // Try to sync with server to recover any partial state
          syncConversation();

          homeDispatch({ field: 'loading', value: false });
          setConversationStreaming(streamConversationId, false);

          // Release wake lock on error
          releaseWakeLock();

          if (error === 'aborted' || error?.name === 'AbortError') {
            saveConversation(updatedConversation);
            // Cancel the stream reader if it exists
            const streamReader = streamReaderByConversationRef.current[streamConversationId];
            if (streamReader) {
              try {
                streamReader.cancel();
              } catch (e) {
                // Reader may already be cancelled, ignore
              }
              streamReaderByConversationRef.current[streamConversationId] = null;
            }
            // Reset the controller after abortion
            resetController(streamConversationId);
            asyncConversationIdRef.current = null;
            return;
          } else {
            logger.error('error during chat completion', error);

            // Preserve partial results with inline error instead of losing everything
            const errorMsg = error?.message || 'Connection lost during streaming';
            const msgs = [...updatedConversation.messages];
            const lastMsg = msgs[msgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.errorMessages = {
                message: errorMsg,
                timestamp: Date.now(),
                recoverable: true,
              };
            } else {
              msgs.push({
                role: 'assistant',
                content: '',
                errorMessages: {
                  message: errorMsg,
                  timestamp: Date.now(),
                  recoverable: true,
                },
              });
            }
            updatedConversation = { ...updatedConversation, messages: msgs };
            homeDispatch({ field: 'selectedConversation', value: updatedConversation });
            const latestConvs = conversationsRef.current.map((c) =>
              c.id === updatedConversation.id ? updatedConversation : c
            );
            homeDispatch({ field: 'conversations', value: latestConvs });
            saveConversation(updatedConversation);
            saveConversations(latestConvs).catch(() => {});

            asyncConversationIdRef.current = null;
            return;
          }
        }
      }
    },
    [
      conversations,
      selectedConversation,
      homeDispatch,
      chatHistory,
      chatCompletionURL,
      expandIntermediateSteps,
      intermediateStepOverride,
      enableIntermediateSteps,
      isPWA,
      startAsyncJob,
      user,
      useDeepThinker,
      t,
      getConversationNameFromMessage,
      getOrCreateController,
      resetController,
      setConversationStreaming,
    ],
  );

  const isSelectedConversationStreaming = Boolean(
    selectedConversation?.id && streamingByConversationId[selectedConversation.id]
  );
  const isSelectedConversationLoading = loading && isSelectedConversationStreaming;

  // Add a new effect to handle streaming state changes
  useEffect(() => {
    if (isSelectedConversationStreaming) {
      // Check if user is at bottom when streaming starts
      if (chatContainerRef.current) {
        const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
        const threshold = Math.max(100, clientHeight * 0.1);
        const isAtBottom = scrollHeight - scrollTop - clientHeight <= threshold;

        if (!isAtBottom && autoScrollEnabled) {
          // User has scrolled up before streaming started, disable auto-scroll
          setAutoScrollEnabled(false);
        }
      }
    }
  }, [isSelectedConversationStreaming, homeDispatch, autoScrollEnabled]);

  // Detect if we're on a mobile device (uses hook value)
  const isMobile = useCallback(() => isMobileDevice, [isMobileDevice]);

  const getDistanceFromBottom = () => {
    if (!chatContainerRef.current) return Number.POSITIVE_INFINITY;
    const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
    return scrollHeight - scrollTop - clientHeight;
  };

  const isNearBottom = (threshold?: number) => {
    const effectiveThreshold = threshold ?? (isMobile() ? 150 : 50);
    return getDistanceFromBottom() <= effectiveThreshold;
  };

  const visibleMessages = useMemo(
    () => (selectedConversation?.messages || []).filter((message) => message.role !== 'system'),
    [selectedConversation?.messages],
  );

  // Retry handler for errored assistant messages: removes the failed assistant message
  // and re-submits the last user message that preceded it.
  const handleRetry = useCallback((erroredMessage: Message) => {
    const conv = selectedConversationRef.current ?? selectedConversation;
    if (!conv) return;
    const msgs = conv.messages;
    const idx = msgs.indexOf(erroredMessage);
    if (idx === -1) return;
    const lastUserMsg = [...msgs].slice(0, idx).reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) return;
    const trimmed = { ...conv, messages: msgs.slice(0, idx) };
    homeDispatch({ field: 'selectedConversation', value: trimmed });
    // Spread to avoid mutating the stored message when handleSend reassigns id
    handleSend({ ...lastUserMsg }, 0, true);
  }, [selectedConversation, homeDispatch, handleSend]);

  const lastVisibleMessage = visibleMessages[visibleMessages.length - 1];
  const lastAssistantContentLength = lastVisibleMessage?.role === 'assistant'
    ? (lastVisibleMessage.content?.length || 0)
    : 0;

  // Enhanced handleScroll that detects user scroll interactions.
  // Uses refs for state reads to keep a stable callback identity, preventing
  // VirtualMessageList from re-rendering on every scroll state change.
  const handleScroll = useCallback(() => {
    const container = chatContainerRef.current;
    if (!container) return;

    const threshold = isMobile() ? 150 : 50;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceFromBottom <= threshold;

    // Immediate reaction to user scroll to avoid race with auto-scroll
    if (!atBottom) {
      if (autoScrollEnabledRef.current || !userScrollLockedRef.current) {
        setAutoScrollEnabled(false);
        setUserScrollLocked(true);
      }
      setShowScrollDownButton(true);
    } else {
      setShowScrollDownButton(false);
      if (!autoScrollEnabledRef.current) {
        setAutoScrollEnabled(true);
      }
      if (userScrollLockedRef.current) {
        setUserScrollLocked(false);
      }
    }

    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = setTimeout(() => {
      lastScrollTop.current = container.scrollTop;
    }, 50);
  }, [isMobile]);

  const handleScrollDown = () => {
    // In PWA mode, don't scroll when keyboard is visible
    if (isPWA && keyboardOffset > 0) {
      return;
    }

    // Clear any pending timeouts
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
    }
    if (autoScrollTimeoutRef.current) {
      clearTimeout(autoScrollTimeoutRef.current);
      autoScrollTimeoutRef.current = null;
    }

    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
    setUserScrollLocked(false);
    setAutoScrollEnabled(true);
    setShowScrollDownButton(false);
  };

  const scrollDown = () => {
    if (userScrollLocked) {
      return;
    }

    // In PWA mode, don't auto-scroll when keyboard is appearing to prevent snap-to-bottom
    if (isPWA && keyboardOffset > 0) {
      return;
    }

    // Only scroll if auto-scroll is enabled
    if (autoScrollEnabled && chatContainerRef.current) {
      // Check if already at bottom to avoid unnecessary scrolls
      const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const threshold = isMobile() ? 150 : 50;

      // Only scroll if not already near bottom
      if (distanceFromBottom > threshold) {
        requestAnimationFrame(() => {
          if (chatContainerRef.current && autoScrollEnabled && !userScrollLocked) {
            chatContainerRef.current.scrollTo({
              top: chatContainerRef.current.scrollHeight,
              behavior: 'auto'
            });
          }
        });
      }
    }
  }

  const handleToggleDeepThinker = useCallback(() => {
    if (quickActionHandlers && typeof (quickActionHandlers as any).onToggleDeepThought === 'function') {
      (quickActionHandlers as any).onToggleDeepThought();
    } else {
      homeDispatch({ field: 'useDeepThinker', value: !useDeepThinker });
      toast.success(!useDeepThinker ? 'Deep Thinker enabled' : 'Deep Thinker disabled');
    }
  }, [quickActionHandlers, homeDispatch, useDeepThinker]);

  // Increased throttle to 500ms to reduce scroll frequency during streaming
  // Combined with the sticky userHasScrolledUp flag, this prevents scroll fighting
  const throttledScrollDown = throttle(scrollDown, 500);

  // Auto-scroll when streaming content grows and user is already near the bottom
  useEffect(() => {
    if (!selectedConversation || !isSelectedConversationStreaming) {
      lastStreamedContentLengthRef.current = 0;
      return;
    }

    if (autoScrollEnabled && !userScrollLocked && lastAssistantContentLength > lastStreamedContentLengthRef.current) {
      const threshold = isMobile() ? 220 : 80;
      if (isNearBottom(threshold)) {
        throttledScrollDown();
      }
    }

    lastStreamedContentLengthRef.current = lastAssistantContentLength;
  }, [
    selectedConversation?.id,
    selectedConversation?.messages?.length,
    lastAssistantContentLength,
    isSelectedConversationStreaming,
    autoScrollEnabled,
    userScrollLocked,
    throttledScrollDown,
  ]);

  // Unified stop handler for both streaming and async modes
  const handleStop = useCallback(() => {
    const conversationId = selectedConversation?.id;
    if (!conversationId) {
      return;
    }
    // Cancel async job if in async mode and polling
    if (isPolling) {
      cancelJob(conversationId);
    }

    // Abort streaming request
    const controller = controllerByConversationRef.current[conversationId];
    if (controller) {
      controller.abort();
      resetController(conversationId);
    }

    // Cancel stream reader if it exists
    const streamReader = streamReaderByConversationRef.current[conversationId];
    if (streamReader) {
      try {
        streamReader.cancel();
      } catch (e) {
        // Reader may already be cancelled, ignore
      }
      streamReaderByConversationRef.current[conversationId] = null;
    }

    // Reset streaming state immediately for better UX
    setConversationStreaming(conversationId, false);
    homeDispatch({ field: 'loading', value: false });
    asyncConversationIdRef.current = null;

    // Flush any pending saves when streaming stops to ensure immediate persistence
    logger.info('Streaming stopped - flushing pending saves to ensure data persistence');
    try {
      debouncedSaveConversation.flush();
      debouncedSaveConversations.flush();
      logger.info('Successfully flushed debounced saves after streaming stop');
    } catch (error) {
      logger.error('Error flushing debounced saves after streaming stop', error);
    }
  }, [isPolling, cancelJob, homeDispatch, resetController, selectedConversation?.id, setConversationStreaming, debouncedSaveConversation, debouncedSaveConversations]);

  const prevConversationIdRef = useRef(selectedConversation?.id);

  // Handle conversation switching and auto-scroll
  useEffect(() => {
    const conversationChanged = prevConversationIdRef.current !== selectedConversation?.id;

    if (conversationChanged) {
      // CRITICAL: Flush any pending debounced saves before switching conversations
      // This prevents data loss when users rapidly switch between conversations
      logger.info('Conversation switching detected - flushing pending saves', {
        fromId: prevConversationIdRef.current,
        toId: selectedConversation?.id
      });

      try {
        debouncedSaveConversation.flush();
        debouncedSaveConversations.flush();
        logger.info('Successfully flushed debounced saves on conversation switch');
      } catch (error) {
        logger.error('Error flushing debounced saves on conversation switch', error);
      }

      // Update previous ID
      prevConversationIdRef.current = selectedConversation?.id;

      // Conversation changed - reset all scroll flags for new conversation
      lastMessageCount.current = visibleMessages.length;
      setAutoScrollEnabled(true);
      setShowScrollDownButton(false);
      setUserScrollLocked(false);

      // Scroll to bottom immediately for conversation switches
      if (chatContainerRef.current) {
        chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
      }
    } else if (selectedConversation && autoScrollEnabled && isSelectedConversationStreaming && !userScrollLocked) {
      // ONLY auto-scroll during streaming if:
      // 1. Auto-scroll is enabled
      // 2. Keyboard is not visible (PWA mode)
      if (isPWA && keyboardOffset > 0) {
        return;
      }

      const currentMessageCount = visibleMessages.length;

      // Only scroll if messages were added (not just content updates)
      if (currentMessageCount > lastMessageCount.current) {
        lastMessageCount.current = currentMessageCount;
        throttledScrollDown();
      }
    }

    selectedConversation &&
      setCurrentMessage(
        selectedConversation.messages[selectedConversation.messages.length - 2],
      );
  }, [selectedConversation, visibleMessages.length, throttledScrollDown, autoScrollEnabled, userScrollLocked, isSelectedConversationStreaming, isPWA, keyboardOffset]);

  // Sync after streaming ends to reconcile any missed updates
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = messageIsStreaming;

    let syncTimeoutId: NodeJS.Timeout | null = null;

    if (wasStreaming && !messageIsStreaming) {
      syncTimeoutId = setTimeout(() => {
        syncConversation(true);
      }, 800);
    }

    // Cleanup: cancel pending sync if component unmounts or streaming state changes again
    return () => {
      if (syncTimeoutId) {
        clearTimeout(syncTimeoutId);
      }
    };
  }, [messageIsStreaming, syncConversation]);

  // Lock auto-scroll on explicit user gestures (wheel/touch)
  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;

    const lockOnUserScroll = () => {
      if (!isNearBottom()) {
        setAutoScrollEnabled(false);
        setUserScrollLocked(true);
        setShowScrollDownButton(true);
      }
    };

    container.addEventListener('wheel', lockOnUserScroll, { passive: true });
    container.addEventListener('touchstart', lockOnUserScroll, { passive: true });
    container.addEventListener('touchmove', lockOnUserScroll, { passive: true });

    return () => {
      container.removeEventListener('wheel', lockOnUserScroll);
      container.removeEventListener('touchstart', lockOnUserScroll);
      container.removeEventListener('touchmove', lockOnUserScroll);
    };
  }, []);

  // Remove the intersection observer - it's causing unwanted scrolls
  // Instead, rely on explicit scroll triggers from new messages
  useEffect(() => {
    // Clean up timeouts on unmount
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (autoScrollTimeoutRef.current) {
        clearTimeout(autoScrollTimeoutRef.current);
      }
      // Flush any pending saves before cancelling
      debouncedSaveConversation.flush();
      debouncedSaveConversations.flush();
      // Then cancel to prevent any new calls
      debouncedSaveConversation.cancel();
      debouncedSaveConversations.cancel();
      // Abort any pending fetch requests
      Object.values(controllerByConversationRef.current).forEach((controller) => {
        controller.abort();
      });
      // Cancel any active stream readers
      Object.values(streamReaderByConversationRef.current).forEach((reader) => {
        if (!reader) return;
        try {
          reader.cancel();
        } catch (e) {
          // Reader may already be cancelled, ignore
        }
      });
      streamReaderByConversationRef.current = {};
      controllerByConversationRef.current = {};
    };
  }, [debouncedSaveConversation, debouncedSaveConversations]);

  const hasMessages = Boolean(visibleMessages.length);
  if (selectedConversation?.id) {
    selectedControllerRef.current = getOrCreateController(selectedConversation.id);
  }

  return (
    <div
      className="relative flex flex-col transition-colors duration-300 ease-in-out"
      style={{
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        // Use flexbox layout instead of fixed positioning to respond to window height changes
        minHeight: 0,
        minWidth: 0, // Prevent flex items from overflowing
        width: '100%',
        maxWidth: '100vw', // Ensure it never exceeds viewport width
        height: '100%', // Use 100% to match parent container which adapts to viewport resize
        overflowX: 'hidden', // Prevent horizontal scrolling
        // Prevent iOS bounce and ensure proper keyboard handling
        WebkitOverflowScrolling: 'touch' as any,
        // Transparent on mobile, colored background on larger screens
        background: 'transparent',
      }}
    >
      <BackgroundProcessingIndicator
        wakeLockActive={wakeLockActive}
        isStreaming={messageIsStreaming}
        isPolling={isPolling}
      />
      <ChatHeader />
      <div
        className="relative flex flex-1 flex-col"
        role="main"
        aria-label="Chat conversation"
        style={{
          minHeight: '0',
          minWidth: 0, // Prevent flex overflow
          isolation: 'isolate',
          overflow: 'hidden',
          width: '100%',
          maxWidth: '100%',
        }}
      >
        <div
          className="flex-1 relative chat-scroll-container"
          // ref is now passed to VirtualMessageList to control the inner scroll container
          data-scroll-container="true"
          aria-live={isSelectedConversationStreaming ? 'polite' : 'off'}
          aria-atomic="false"
          aria-relevant="additions"
          style={{
            position: 'relative',
            height: '100%',
            width: '100%',
            maxWidth: '100%',
            minWidth: 0, // Prevent flex overflow
            // Improve mobile scrolling
            WebkitOverflowScrolling: 'touch' as any,
          }}
        >
          <div className="mx-auto flex h-full w-full max-w-5xl flex-col responsive-px pb-0 pt-4 sm:pt-6" style={{ minWidth: 0, maxWidth: '100%' }}>
            {loading && !hasMessages ? (
              // Show skeleton loading state while loading conversations
              <div className="flex-1 min-h-0 overflow-hidden">
                <ChatLoadingSkeleton className="max-w-3xl mx-auto" />
              </div>
            ) : hasMessages ? (
              <div className="flex-1 min-h-0">
                <VirtualMessageList
                  ref={chatContainerRef}
                  messages={visibleMessages}
                  containerHeight={
                    chatContainerRef.current
                      ? chatContainerRef.current.offsetHeight
                      : window.innerHeight - (isLandscape && isKeyboardVisible ? 100 : 180)
                  }
                  onScroll={handleScroll}
                  onRetry={handleRetry}
                />
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center py-8 px-4 animate-fade-in">
                <div className="mb-6">
                  <GalaxyAnimation />
                </div>
                <h2 className="text-lg sm:text-xl font-semibold text-neutral-800 dark:text-neutral-100 mb-2 text-center">
                  How can I help you today?
                </h2>
                <p className="text-sm text-neutral-500 dark:text-neutral-400 max-w-md text-center mb-6">
                  Ask anything — I can help with research, analysis, code, and creative tasks.
                </p>
                <div className="flex flex-wrap justify-center gap-2 max-w-lg">
                  <button
                    onClick={() => {
                      const message: Message = {
                        role: 'user',
                        content: 'Run my daily briefing',
                      };
                      setCurrentMessage(message);
                      handleSend(message, 0);
                    }}
                    className="px-4 py-2 rounded-full text-sm font-medium
                      bg-white/60 dark:bg-white/5
                      border border-neutral-200/60 dark:border-white/10
                      text-neutral-700 dark:text-neutral-300
                      hover:bg-nvidia-green/10 hover:border-nvidia-green/30 hover:text-nvidia-green
                      dark:hover:bg-nvidia-green/10 dark:hover:border-nvidia-green/30 dark:hover:text-nvidia-green
                      transition-all duration-200
                      backdrop-blur-sm"
                  >
                    Run my daily briefing
                  </button>
                </div>
              </div>
            )}

            {/* ChatLoader: bouncing dots for initial wait before first text/steps */}
            {(() => {
              const showChatLoader = isSelectedConversationLoading &&
                !(lastVisibleMessage?.role === 'assistant' && lastVisibleMessage?.intermediateSteps?.length);
              return (
                <>
                  {showChatLoader && (
                    <ChatLoader useDeepThinker={useDeepThinker} />
                  )}

                  {/* Agent heartbeat: persistent "alive" indicator while streaming.
                      Shows whenever streaming is active and the ChatLoader isn't visible,
                      including async/polling mode where `loading` stays true the
                      entire duration. */}
                  {isSelectedConversationStreaming && !showChatLoader && (
                    <AgentHeartbeat
                      currentActivityText={currentActivityText}
                      completedStepCategories={completedStepCategories}
                      useDeepThinker={useDeepThinker}
                    />
                  )}
                </>
              );
            })()}

          </div>
        </div>

      </div>

      {/* Chat input - positioned to stay above keyboard */}
      {/* On mobile, use transparent background to maximize content visibility */}
      <div
        className="w-full border-t border-transparent bg-transparent sm:bg-bg-secondary dark:sm:bg-dark-bg-primary flex-shrink-0"
        style={{
          position: 'relative',
          zIndex: 30,
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          overflowX: 'hidden', // Prevent horizontal overflow
          // Add transform to prevent iOS keyboard push
          transform: 'translateZ(0)',
          WebkitTransform: 'translateZ(0)',
          // Allow overflow for dropdown (vertical only)
          overflowY: 'visible',
        }}
      >
        <div
          className="mx-auto w-full px-1 sm:responsive-px pb-0 pt-0 sm:pb-4 sm:pt-2 md:pb-6 md:pt-3"
          style={{
            width: '100%',
            maxWidth: '100%',
            minWidth: 0,
            // Only add safe area padding on mobile when keyboard is NOT visible
            // When keyboard is visible (detected by resize OR focus), the viewport resizes, so we don't need extra padding
            paddingBottom: (isKeyboardVisible || (isMobile() && isInputFocused))
              ? '0px'
              : 'env(safe-area-inset-bottom, 0px)',
            // Ensure sufficient bottom spacing in landscape to prevent input cutoff
            marginBottom: (isLandscape && isKeyboardVisible) ? '0px' : '0px',
          }}
        >
          <ChatInput
            textareaRef={textareaRef}
            isStreaming={isSelectedConversationStreaming}
            isAnyStreaming={messageIsStreaming}
            onFocusChange={(focused) => {
              setIsInputFocused(focused);
              if (focused && isMobile()) {
                setAutoScrollEnabled(false);
              }
            }}
            onSend={(message) => {
              setCurrentMessage(message);
              handleSend(message, 0);
            }}
            onRegenerate={() => {
              if (currentMessage && currentMessage?.role === 'user') {
                handleSend(currentMessage, 0);
              } else {
                const lastUserMessage = fetchLastMessage({
                  messages: (selectedConversation?.messages as any[]) || [],
                  role: 'user',
                });
                lastUserMessage && handleSend(lastUserMessage, 1);
              }
            }}
            showScrollDownButton={showScrollDownButton}
            onScrollDownClick={handleScrollDown}
            controller={selectedControllerRef}
            onStop={handleStop}
            onQuickActionsRegister={(handlers) => {
              // Pass handlers up to the parent component through context
              if (quickActionHandlers && '__setHandlers' in quickActionHandlers) {
                (quickActionHandlers as any).__setHandlers(handlers);
              }
            }}
          />
        </div>
      </div>
    </div>
  );
};
Chat.displayName = 'Chat';
