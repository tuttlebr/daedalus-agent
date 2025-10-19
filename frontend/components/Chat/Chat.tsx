'use client';
import { IconBrain, IconArrowDown } from '@tabler/icons-react';
import {
  useCallback,
  useContext,
  useEffect,
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
import { getUserSessionItem } from '@/utils/app/storage';
import { ChatBody, Conversation, Message } from '@/types/chat';
import {
  IntermediateStep,
  IntermediateStepState,
  IntermediateStepType,
  getEventState,
} from '@/types/intermediateSteps';
import { SSEClient, createSSEUrl } from '@/services/sse';
import HomeContext from '@/pages/api/home/home.context';
import { ChatInput } from './ChatInput';
import { ChatLoader } from './ChatLoader';
import { MemoizedChatMessage } from './MemoizedChatMessage';
import { cleanMessagesForLLM, processMessageImages } from '@/utils/app/imageHandler';
import { GalaxyAnimation } from '@/components/GalaxyAnimation';

import { v4 as uuidv4 } from 'uuid';
import { ChatHeader } from './ChatHeader';
import { useAuth } from '@/components/Auth/AuthProvider';
import { useIOSKeyboardFix } from '@/hooks/useIOSKeyboardFix';

export const Chat = () => {
  const { t } = useTranslation('chat');
  const { user, isLoading: authLoading } = useAuth();
  const {
    state: {
      selectedConversation,
      conversations,
      messageIsStreaming,
      loading,
      chatHistory,
      chatCompletionURL,
      expandIntermediateSteps,
      intermediateStepOverride,
      enableIntermediateSteps,
      useDeepThinker
    },
    handleUpdateConversation,
    dispatch: homeDispatch,
    quickActionHandlers,
  } = useContext(HomeContext);

  const [currentMessage, setCurrentMessage] = useState<Message>();
  const [autoScrollEnabled, setAutoScrollEnabled] = useState<boolean>(true);
  const [showScrollDownButton, setShowScrollDownButton] =
    useState<boolean>(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const controllerRef = useRef(new AbortController());
  const selectedConversationRef = useRef(selectedConversation);

  const lastScrollTop = useRef(0); // Store last known scroll position
  const lastTouchY = useRef(0); // Track touch position for mobile
  const isUserScrolling = useRef(false); // Track if user is actively scrolling

  // Add these variables near the top of your component
  useEffect(() => {
    selectedConversationRef.current = selectedConversation;
  }, [selectedConversation]);

  const mergeIntermediateSteps = useCallback(
    (
      existingSteps: IntermediateStep[] = [],
      incomingSteps: IntermediateStep[] = [],
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

        const current = stepsById.get(uuid);
        if (current) {
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
      if (selectedConversation) {
        let updatedConversation: Conversation;
        if (deleteCount) {
          const updatedMessages = [...selectedConversation.messages];
          for (let i = 0; i < deleteCount; i++) {
            updatedMessages.pop();
          }
          updatedConversation = {
            ...selectedConversation,
            messages: [...updatedMessages, message],
          };
        } else {
          // Process message to store images in Redis if needed
          const processedMessage = await processMessageImages(message);
          updatedConversation = {
            ...selectedConversation,
            messages: [
              ...selectedConversation.messages,
              processedMessage,
            ],
          };
        }
        homeDispatch({
          field: 'selectedConversation',
          value: updatedConversation,
        });

        homeDispatch({ field: 'loading', value: true });
        homeDispatch({ field: 'messageIsStreaming', value: true });

        // Store processed conversation
        saveConversation(updatedConversation);
        const updatedConversations: Conversation[] = conversations.map(
          (conversation) => {
            if (conversation.id === selectedConversation.id) {
              return updatedConversation;
            }
            return conversation;
          },
        );
        if (updatedConversations.length === 0) {
          updatedConversations.push(updatedConversation);
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
        const lastMessage = messagesCleaned[messagesCleaned.length - 1];
        if (lastMessage?.role === 'user') {
          lastMessage.content = `${lastMessage.content}`;

          // Append Deep Thinker workflow instructions only if the metadata flag is set
          if ((lastMessage as any).metadata?.useDeepThinker) {
            lastMessage.content = `${lastMessage.content}\n\nToday is ${formattedDate}.\n\nDEEP RESEARCH NEEDED: You must follow the researcher workflow: query_writer_researcher → execute research → summarizer_researcher → (optional) reflection_researcher/report_extender_researcher → finalize_report_researcher.`;
          }
        }

        const systemContextMessages: Message[] = [];

        if (user?.username) {
          systemContextMessages.push({
            role: 'system',
            content: `The authenticated user's username is "${user.username}".`
          });
        } else {
          systemContextMessages.push({
            role: 'system',
            content: 'The user is authenticated as "anon".'
          });
        }

        const chatBody: ChatBody = {
          messages: [...systemContextMessages, ...messagesCleaned],
          // Use user-specific storage key to prevent data leakage between users
          chatCompletionURL: getUserSessionItem('chatCompletionURL') || chatCompletionURL,
          additionalProps: {
            enableIntermediateSteps: getUserSessionItem('enableIntermediateSteps')
              ? getUserSessionItem('enableIntermediateSteps') === 'true'
              : enableIntermediateSteps,
            username: user?.username || 'anon'
          }
        };

        const endpoint = getEndpoint({ service: 'chat' });
        let body;
        body = JSON.stringify({
          ...chatBody,
        });

        let response;
        try {
          console.log('aiq - sending chat request payload', {
            endpoint,
            messageCount: messagesCleaned.length,
            messagesPreview: messagesCleaned,
          });
          response = await fetch(`${endpoint}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            signal: controllerRef.current.signal, // Use ref here
            body,
          });

          if (!response?.ok) {
            homeDispatch({ field: 'loading', value: false });
            homeDispatch({ field: 'messageIsStreaming', value: false });
            toast.error(response.statusText);
            return;
          }

          const data = response?.body;
          if (!data) {
            homeDispatch({ field: 'loading', value: false });
            homeDispatch({ field: 'messageIsStreaming', value: false });
            toast.error('Error: No data received from server');
            return;
          }
          if (!false) {
            if (updatedConversation.messages.length === 1) {
              const { content } = message;
              const customName =
                content.length > 30
                  ? content.substring(0, 30) + '...'
                  : content;
              updatedConversation = {
                ...updatedConversation,
                name: customName,
              };
            }
            homeDispatch({ field: 'loading', value: false });
            const reader = data.getReader();
            const decoder = new TextDecoder();
            let done = false;
            let isFirst = true;
            let text = '';
            let counter = 1;
            let intermediateStepBuffer = ''; // Buffer for accumulating partial intermediate steps
            while (!done) {
              const { value, done: doneReading } = await reader.read();
              done = doneReading;
              let chunkValue = decoder.decode(value);
              counter++;

              // Add current chunk to any buffered content
              chunkValue = intermediateStepBuffer + chunkValue;
              intermediateStepBuffer = '';

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
                  console.error('Failed to parse intermediate step JSON:', error);
                  // Still continue - we'll remove the tags below to prevent raw display
                }
              }

              rawIntermediateSteps = rawIntermediateSteps.filter((step) => {
                if (!step?.payload?.event_type) {
                  return false;
                }
                return getEventState(step.payload.event_type) !== IntermediateStepState.CHUNK;
              });

              // ALWAYS remove intermediate step tags from visible content, even if parsing failed
              // This prevents raw JSON from being displayed to users
              chunkValue = chunkValue.replace(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g, '');

              // LEGACY: React agent tool-call artifacts (commented out - verify if still needed)
              // const toolOpenIdx = chunkValue.lastIndexOf('<TOOLCALL>');
              // const toolCloseIdx = chunkValue.lastIndexOf('</TOOLCALL>');
              // if (toolOpenIdx > toolCloseIdx) {
              //   partialToolCall = chunkValue.substring(toolOpenIdx);
              //   chunkValue = chunkValue.substring(0, toolOpenIdx);
              // }
              // if (partialToolCall) {
              //   const maybeCloseIdx = chunkValue.indexOf('</TOOLCALL>');
              //   if (maybeCloseIdx !== -1) {
              //     // Complete the partial
              //     const completed = partialToolCall + chunkValue.substring(0, maybeCloseIdx + '</TOOLCALL>'.length);
              //     chunkValue = chunkValue.substring(maybeCloseIdx + '</TOOLCALL>'.length);
              //     partialToolCall = '';
              //     // Prepend for parsing below
              //     chunkValue = completed + chunkValue;
              //   }
              // }

              // // Extract complete <TOOLCALL> blocks and convert them to intermediate steps
              // const toolCallMatches = chunkValue.match(/<TOOLCALL>[\s\S]*?<\/TOOLCALL>/g) || [];
              // if (toolCallMatches.length > 0) {
              //   for (const m of toolCallMatches) {
              //     try {
              //       const inner = m.replace('<TOOLCALL>', '').replace('</TOOLCALL>', '').trim();
              //       let pretty = inner;
              //       try {
              //         const obj = JSON.parse(inner);
              //         pretty = JSON.stringify(obj, null, 2);
              //       } catch (_) {
              //         // keep raw inner if not valid JSON
              //       }
              //       const intermediate_message: IntermediateStep = {
              //         parent_id: 'agent_tool',
              //         function_ancestry: {
              //           node_id: `toolcall-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
              //           parent_id: 'agent_tool',
              //           function_name: 'Tool Call',
              //           depth: 0
              //         },
              //         payload: {
              //           event_type: IntermediateStepType.TOOL_END,
              //           event_timestamp: Date.now() / 1000,
              //           name: 'Tool Call',
              //           metadata: {
              //             tool_output: pretty
              //           },
              //           data: {
              //             output: pretty
              //           },
              //           UUID: `toolcall-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
              //         }
              //       };
              //       rawIntermediateSteps.push(intermediate_message);
              //     } catch (_) {
              //       // ignore malformed blocks
              //     }
              //   }
              //   // Remove all TOOLCALL blocks from visible content
              //   chunkValue = chunkValue.replace(/<TOOLCALL>[\s\S]*?<\/TOOLCALL>/g, '');
              // }

              // LEGACY: Hide orchestration scaffolding from react_agent outputs (commented out - verify if still needed)
              // chunkValue = chunkValue.replace(/^(Thought:|Action:|Action Input:|Observation:).*$/gm, '');
              // chunkValue = chunkValue.replace(/\bFinal Answer:\s*/g, '');

              text = text + chunkValue;

              homeDispatch({ field: 'loading', value: false });
              const updatedMessages: Message[] = isFirst
                ? [
                    ...updatedConversation.messages,
                    {
                      role: 'assistant',
                      content: text,
                      intermediateSteps: mergeIntermediateSteps(
                        [],
                        rawIntermediateSteps,
                      ),
                    },
                  ]
                : updatedConversation.messages.map((message, index) => {
                    if (index === updatedConversation.messages.length - 1) {
                      return {
                        ...message,
                        content: text,
                        intermediateSteps: mergeIntermediateSteps(
                          message?.intermediateSteps,
                          rawIntermediateSteps,
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

              homeDispatch({
                field: 'selectedConversation',
                value: updatedConversation,
              });
            }

            // Process any base64 images in the assistant's message content
            // This happens after streaming is complete
            const lastMessage = updatedConversation.messages[updatedConversation.messages.length - 1];
            if (lastMessage && lastMessage.role === 'assistant' && lastMessage.content) {
              const { processMarkdownImages } = await import('@/utils/app/imageHandler');
              const processedContent = await processMarkdownImages(lastMessage.content);

              // Update the message with processed content (base64 replaced with references)
              if (processedContent !== lastMessage.content) {
                console.log('Image processing: Replaced base64 images with Redis references');

                // Create NEW message and conversation objects to trigger React re-render
                const updatedMessage = { ...lastMessage, content: processedContent };
                const updatedMessages = [
                  ...updatedConversation.messages.slice(0, -1),
                  updatedMessage
                ];

                updatedConversation = {
                  ...updatedConversation,
                  messages: updatedMessages,
                };

                // Update the conversation state to trigger re-render with processed images
                homeDispatch({
                  field: 'selectedConversation',
                  value: updatedConversation,
                });
              }
            }

            saveConversation(updatedConversation);
            const updatedConversations: Conversation[] = conversations.map(
              (conversation) => {
                if (conversation.id === selectedConversation.id) {
                  return updatedConversation;
                }
                return conversation;
              },
            );
            if (updatedConversations.length === 0) {
              updatedConversations.push(updatedConversation);
            }
            homeDispatch({
              field: 'conversations',
              value: updatedConversations,
            });
            saveConversations(updatedConversations);
            // to show the message on UI and scroll to the bottom after 500ms delay
            setTimeout(() => {
              homeDispatch({ field: 'messageIsStreaming', value: false });
              homeDispatch({ field: 'loading', value: false });
            }, 200);
          } else {
            const { answer } = await response?.json();

            // Process any base64 images in the response
            const { processMarkdownImages } = await import('@/utils/app/imageHandler');
            const processedAnswer = await processMarkdownImages(answer);

            if (processedAnswer !== answer) {
              console.log('Image processing: Replaced base64 images with Redis references');
            }

            const updatedMessages: Message[] = [
              ...updatedConversation.messages,
              { role: 'assistant', content: processedAnswer },
            ];
            updatedConversation = {
              ...updatedConversation,
              messages: updatedMessages,
            };
            homeDispatch({
              field: 'selectedConversation',
              value: updatedConversation,
            });
            saveConversation(updatedConversation);
            const updatedConversations: Conversation[] = conversations.map(
              (conversation) => {
                if (conversation.id === selectedConversation.id) {
                  return updatedConversation;
                }
                return conversation;
              },
            );
            if (updatedConversations.length === 0) {
              updatedConversations.push(updatedConversation);
            }
            homeDispatch({
              field: 'conversations',
              value: updatedConversations,
            });
            saveConversations(updatedConversations);
            homeDispatch({ field: 'loading', value: false });
            homeDispatch({ field: 'messageIsStreaming', value: false });
          }
        } catch (error: any) {
          saveConversation(updatedConversation);
          homeDispatch({ field: 'loading', value: false });
          homeDispatch({ field: 'messageIsStreaming', value: false });
          if (error === 'aborted' || error?.name === 'AbortError') {
            return;
          } else {
            console.log('error during chat completion - ', error);
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
      enableIntermediateSteps
    ],
  );

  // Add a new effect to handle streaming state changes
  useEffect(() => {
    if (messageIsStreaming) {
      // Only enable auto-scroll if user is already at bottom
      if (chatContainerRef.current) {
        const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
        const threshold = Math.max(100, clientHeight * 0.1); // Larger threshold for mobile
        const isAtBottom = scrollHeight - scrollTop - clientHeight <= threshold;
        if (isAtBottom) {
          setAutoScrollEnabled(true);
          setShowScrollDownButton(false);
          homeDispatch({ field: 'autoScroll', value: true });
        }
      }
    }
  }, [messageIsStreaming, homeDispatch]);

  // Detect if we're on a mobile device
  const isMobile = () => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 768;
  };

  // Add an effect to set up wheel and touchmove event listeners
  const handleScroll = useCallback(() => {
    if (!chatContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
    // Use larger threshold on mobile to prevent accidental re-enabling
    const threshold = isMobile() ? Math.max(100, clientHeight * 0.1) : Math.max(24, clientHeight * 0.02);
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= threshold;

    // Track scroll direction
    const isScrollingUp = scrollTop < lastScrollTop.current;

    if (!isAtBottom) {
      if (autoScrollEnabled) {
        setAutoScrollEnabled(false);
        homeDispatch({ field: 'autoScroll', value: false });
      }
      if (!showScrollDownButton) {
        setShowScrollDownButton(true);
      }
    } else {
      // Only re-enable auto-scroll if not actively scrolling up and not on mobile
      if (!autoScrollEnabled && !isScrollingUp && !isMobile()) {
        setAutoScrollEnabled(true);
        homeDispatch({ field: 'autoScroll', value: true });
      }
      if (showScrollDownButton && !isScrollingUp) {
        setShowScrollDownButton(false);
      }
    }
    lastScrollTop.current = scrollTop;
  }, [autoScrollEnabled, homeDispatch, showScrollDownButton]);

  const handleScrollDown = () => {
    chatContainerRef.current?.scrollTo({
      top: chatContainerRef.current.scrollHeight,
      behavior: 'smooth',
    });
    setAutoScrollEnabled(true);
    homeDispatch({ field: 'autoScroll', value: true });
  };

  const scrollDown = () => {
    // Don't scroll if user is actively scrolling on mobile
    if (autoScrollEnabled && !isUserScrolling.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
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

  const throttledScrollDown = throttle(scrollDown, 250);

  useEffect(() => {
    // Only auto-scroll on conversation change if auto-scroll is enabled
    if (autoScrollEnabled) {
      throttledScrollDown();
    }
    selectedConversation &&
      setCurrentMessage(
        selectedConversation.messages[selectedConversation.messages.length - 2],
      );
  }, [selectedConversation, throttledScrollDown, autoScrollEnabled]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Only auto-scroll if enabled AND user hasn't manually scrolled up
        if (autoScrollEnabled && messageIsStreaming && entry.isIntersecting) {
          // Check if user is actively interacting
          const now = Date.now();
          const timeSinceLastScroll = now - (lastScrollTop.current || 0);
          // Don't auto-scroll if user scrolled in the last 2 seconds
          if (timeSinceLastScroll > 2000) {
            requestAnimationFrame(() => {
              messagesEndRef.current?.scrollIntoView({
                behavior: 'smooth',
                block: 'end',
              });
            });
          }
        }
      },
      {
        root: null,
        threshold: 0.5,
      }
    );

    const messagesEndElement = messagesEndRef.current;
    if (messagesEndElement) {
      observer.observe(messagesEndElement);
    }
    return () => {
      if (messagesEndElement) {
        observer.unobserve(messagesEndElement);
      }
    };
  }, [autoScrollEnabled, messageIsStreaming]);

  const hasMessages = Boolean(selectedConversation?.messages?.length);

  // Use iOS keyboard fix hook
  const { isKeyboardVisible, keyboardHeight, viewportHeight } = useIOSKeyboardFix();

  return (
    <div
      className="relative flex h-screen flex-col bg-bg-secondary transition-colors duration-300 ease-in-out dark:bg-dark-bg-primary"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        height: viewportHeight > 0 ? `${viewportHeight}px` : '100vh',
        // Use fixed positioning but adjust for iOS keyboard
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        // Prevent iOS bounce and ensure proper keyboard handling
        WebkitOverflowScrolling: 'touch' as any,
        overscrollBehavior: 'none',
      }}
    >
      <ChatHeader />
      <div className="relative flex flex-1 flex-col overflow-hidden" style={{ minHeight: '0', isolation: 'isolate' }}>
        <div
          className="flex-1 overflow-y-auto relative momentum-scroll"
          ref={chatContainerRef}
          onScroll={handleScroll}
          onTouchStart={(e) => {
            lastTouchY.current = e.touches[0].clientY;
            isUserScrolling.current = true;
          }}
          onTouchMove={(e) => {
            const touchY = e.touches[0].clientY;
            const deltaY = lastTouchY.current - touchY;

            // If scrolling up, disable auto-scroll
            if (deltaY < 0 && autoScrollEnabled) {
              setAutoScrollEnabled(false);
              homeDispatch({ field: 'autoScroll', value: false });
            }
            lastTouchY.current = touchY;
          }}
          onTouchEnd={() => {
            isUserScrolling.current = false;
          }}
          style={{
            // Prevent overscroll bounce that can cause input issues
            overscrollBehaviorY: 'contain',
            position: 'relative',
            height: '100%',
            // Improve mobile scrolling
            WebkitOverflowScrolling: 'touch' as any,
          }}
        >
          <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-3 sm:px-4 md:px-6 pb-0 pt-3 sm:pt-6">
            {hasMessages ? (
              <div className="flex flex-col space-y-1 sm:space-y-2 min-w-0">
                {selectedConversation?.messages.map((message, index) => (
                  <MemoizedChatMessage
                    key={message.id || index}
                    message={message}
                    messageIndex={index}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center py-8">
                <div className="animate-fade-in">
                  <GalaxyAnimation containerSize={180} />
                </div>
              </div>
            )}

            {loading && <ChatLoader statusUpdateText={`Thinking...`} />}

            {/* Spacer to prevent content from being hidden behind the input area */}
            <div className="h-32 shrink-0" ref={messagesEndRef} />
          </div>
        </div>

        {/* Scroll down button */}
        {showScrollDownButton && (
          <div className="absolute bottom-4 right-4">
            <button
              className="flex h-10 w-10 items-center justify-center rounded-full apple-glass backdrop-blur-xl border border-white/20 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.24)] text-neutral-700 dark:text-white/80 transition-all duration-200 hover:bg-white/20 hover:border-nvidia-green/40"
              onClick={handleScrollDown}
              aria-label={t('Scroll to bottom') as string}
            >
              <IconArrowDown size={18} />
            </button>
          </div>
        )}
      </div>

      {/* Chat input - positioned to stay above keyboard */}
      <div className="w-full border-t border-transparent bg-bg-secondary dark:bg-dark-bg-primary"
        style={{
          position: isKeyboardVisible ? 'fixed' : 'relative',
          bottom: isKeyboardVisible ? 0 : 'auto',
          left: 0,
          right: 0,
          zIndex: 30,
          // Ensure input stays at the bottom
          marginTop: isKeyboardVisible ? 0 : 'auto',
          flexShrink: 0,
          // Add transform to prevent iOS keyboard push
          transform: 'translateZ(0)',
          WebkitTransform: 'translateZ(0)',
        }}>
        <div className="mx-auto max-w-5xl px-3 pb-6 pt-3 sm:px-4 md:px-6"
          style={{
            // Additional padding when keyboard is visible
            paddingBottom: isKeyboardVisible ? 'max(24px, env(safe-area-inset-bottom))' : '24px',
          }}>
          <ChatInput
            textareaRef={textareaRef}
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
            controller={controllerRef}
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
