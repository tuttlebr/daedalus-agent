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
import { useVisualViewport } from '@/hooks/useVisualViewport';
import { useBackgroundProcessing } from '@/hooks/useBackgroundProcessing';
import { notifyStreamingComplete, notifyStreamingInterrupted, requestNotificationPermission } from '@/utils/notifications';
import { useAsyncChat } from '@/hooks/useAsyncChat';

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
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null); // Debounce scroll events
  const autoScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null); // Delay auto-scroll re-enabling

  // Use iOS keyboard fix hook and PWA keyboard handling - must be before function definitions
  const { isKeyboardVisible, keyboardHeight, viewportHeight } = useIOSKeyboardFix();
  const keyboardOffset = useVisualViewport();
  const isPWA = typeof window !== 'undefined' && 
    (window.matchMedia('(display-mode: standalone)').matches || 
     (window.navigator as any).standalone === true);

  // Background processing support for PWA
  const {
    wakeLockActive,
    isVisible,
    requestWakeLock,
    releaseWakeLock,
    saveStreamingState,
    getStreamingState,
    clearStreamingState,
  } = useBackgroundProcessing();

  // Async chat for background processing (PWA mode)
  const {
    startAsyncJob,
    jobStatus,
    isPolling,
    cancelJob,
  } = useAsyncChat({
    onProgress: (status) => {
      // Update UI with partial response
      if (status.partialResponse && selectedConversation) {
        const updatedMessages = [...selectedConversation.messages];
        const lastMessage = updatedMessages[updatedMessages.length - 1];
        
        if (lastMessage && lastMessage.role === 'assistant') {
          lastMessage.content = status.partialResponse;
          lastMessage.intermediateSteps = status.intermediateSteps || [];
        } else {
          updatedMessages.push({
            role: 'assistant',
            content: status.partialResponse,
            intermediateSteps: status.intermediateSteps || [],
          });
        }

        const updatedConversation = {
          ...selectedConversation,
          messages: updatedMessages,
        };

        homeDispatch({
          field: 'selectedConversation',
          value: updatedConversation,
        });
      }
    },
    onComplete: async (fullResponse, intermediateSteps) => {
      console.log('Async job completed with full response');
      
      if (selectedConversation) {
        const updatedMessages = [...selectedConversation.messages];
        const lastMessage = updatedMessages[updatedMessages.length - 1];
        
        if (lastMessage && lastMessage.role === 'assistant') {
          lastMessage.content = fullResponse;
          lastMessage.intermediateSteps = intermediateSteps || [];
        } else {
          updatedMessages.push({
            role: 'assistant',
            content: fullResponse,
            intermediateSteps: intermediateSteps || [],
          });
        }

        const updatedConversation = {
          ...selectedConversation,
          messages: updatedMessages,
        };

        homeDispatch({
          field: 'selectedConversation',
          value: updatedConversation,
        });

        saveConversation(updatedConversation);
        const updatedConversations = conversations.map((c) =>
          c.id === selectedConversation.id ? updatedConversation : c
        );
        homeDispatch({
          field: 'conversations',
          value: updatedConversations,
        });
        saveConversations(updatedConversations);
      }

      // Release wake lock and notify
      if (isPWA) {
        await releaseWakeLock();
        await clearStreamingState();
        await notifyStreamingComplete(selectedConversation?.name);
      }

      homeDispatch({ field: 'messageIsStreaming', value: false });
      homeDispatch({ field: 'loading', value: false });
    },
    onError: async (error) => {
      console.error('Async job error:', error);
      toast.error(`Error: ${error}`);

      if (isPWA) {
        await releaseWakeLock();
        await clearStreamingState();
      }

      homeDispatch({ field: 'messageIsStreaming', value: false });
      homeDispatch({ field: 'loading', value: false });
    },
  });

  // Add these variables near the top of your component
  useEffect(() => {
    selectedConversationRef.current = selectedConversation;
  }, [selectedConversation]);

  // Request notification permission on mount for PWA background processing
  useEffect(() => {
    if (isPWA) {
      requestNotificationPermission().then(permission => {
        if (permission === 'granted') {
          console.log('Notification permission granted for background processing');
        } else {
          console.log('Notification permission denied - user will not receive completion alerts');
        }
      });
    }
  }, [isPWA]);

  // Monitor visibility changes to notify user when app is backgrounded during streaming
  useEffect(() => {
    if (!isPWA || !messageIsStreaming) return;

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'hidden') {
        console.log('App went to background while streaming - notifying user');
        await notifyStreamingInterrupted();
      } else {
        console.log('App returned to foreground - resuming normal operation');
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isPWA, messageIsStreaming]);

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
        // Check if we should use async mode (PWA for background processing)
        const useAsyncMode = isPWA;
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

        // Request wake lock to keep screen on during streaming
        if (isPWA) {
          await requestWakeLock();
          console.log('Wake lock requested for background processing');
        }

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
            username: user?.username || 'anon',
            useDeepThinker: useDeepThinker
          }
        };

        // Use async mode for PWA to support background processing
        if (useAsyncMode) {
          console.log('Using async mode for background processing');
          try {
            await startAsyncJob(
              chatBody.messages || [],
              chatBody.chatCompletionURL || '',
              chatBody.additionalProps || {},
              user?.username || 'anon'
            );
            console.log('Async job started successfully');
          } catch (error: any) {
            console.error('Failed to start async job:', error);
            toast.error(`Failed to start request: ${error.message}`);
            
            homeDispatch({ field: 'loading', value: false });
            homeDispatch({ field: 'messageIsStreaming', value: false });
            
            if (isPWA) {
              await releaseWakeLock();
            }
          }
          return; // Exit early for async mode
        }

        // Standard streaming mode (browser/non-PWA)
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

              // Save streaming state periodically for recovery (every 10 chunks)
              if (isPWA && counter % 10 === 0) {
                await saveStreamingState({
                  isStreaming: true,
                  conversationId: selectedConversation.id,
                  partialResponse: text,
                  timestamp: Date.now(),
                });
              }

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
            
            // Release wake lock and clear streaming state
            if (isPWA) {
              await releaseWakeLock();
              await clearStreamingState();
              console.log('Wake lock released and streaming state cleared');
              
              // Notify user that response is complete
              await notifyStreamingComplete(selectedConversation.name);
            }
            
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
            
            // Release wake lock and clear streaming state (non-streaming path)
            if (isPWA) {
              await releaseWakeLock();
              await clearStreamingState();
            }
            
            homeDispatch({ field: 'loading', value: false });
            homeDispatch({ field: 'messageIsStreaming', value: false });
          }
        } catch (error: any) {
          saveConversation(updatedConversation);
          
          // Release wake lock on error
          if (isPWA) {
            await releaseWakeLock();
            await clearStreamingState();
          }
          
          homeDispatch({ field: 'loading', value: false });
          homeDispatch({ field: 'messageIsStreaming', value: false });
          if (error === 'aborted' || error?.name === 'AbortError') {
            // Reset the controller after abortion
            controllerRef.current = new AbortController();
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
      enableIntermediateSteps,
      isPWA,
      requestWakeLock,
      releaseWakeLock,
      saveStreamingState,
      clearStreamingState,
      startAsyncJob,
      user,
      useDeepThinker,
    ],
  );

  // Add a new effect to handle streaming state changes
  useEffect(() => {
    if (messageIsStreaming) {
      // Only enable auto-scroll if user was already at bottom before streaming started
      // Don't force auto-scroll on users who are reading previous messages
      if (chatContainerRef.current && autoScrollEnabled) {
        const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
        const threshold = Math.max(100, clientHeight * 0.1); // Larger threshold for mobile
        const isAtBottom = scrollHeight - scrollTop - clientHeight <= threshold;
        if (!isAtBottom) {
          // User has scrolled up, respect their choice
          setAutoScrollEnabled(false);
          homeDispatch({ field: 'autoScroll', value: false });
        }
      }
    }
  }, [messageIsStreaming, homeDispatch, autoScrollEnabled]);

  // Detect if we're on a mobile device
  const isMobile = () => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 768;
  };

  // Improved handleScroll with debouncing and better logic
  const handleScroll = useCallback(() => {
    if (!chatContainerRef.current || isUserScrolling.current) return;

    // Clear existing timeout
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    // Debounce scroll handling
    scrollTimeoutRef.current = setTimeout(() => {
      if (!chatContainerRef.current) return;

      const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      // Increased threshold for better UX
      const threshold = isMobile() ? 150 : 50;
      const isAtBottom = distanceFromBottom <= threshold;

      // Track scroll direction
      const isScrollingUp = scrollTop < lastScrollTop.current - 5; // Add 5px deadzone
      const isScrollingDown = scrollTop > lastScrollTop.current + 5;

      // User scrolled up - disable auto-scroll
      if (isScrollingUp && distanceFromBottom > threshold) {
        if (autoScrollEnabled) {
          setAutoScrollEnabled(false);
          homeDispatch({ field: 'autoScroll', value: false });
        }
        setShowScrollDownButton(true);

        // Clear any pending auto-scroll re-enable
        if (autoScrollTimeoutRef.current) {
          clearTimeout(autoScrollTimeoutRef.current);
          autoScrollTimeoutRef.current = null;
        }
      }
      // User scrolled to bottom - show button but don't auto-enable yet
      else if (isAtBottom && !messageIsStreaming) {
        setShowScrollDownButton(false);

        // Delay auto-scroll re-enabling to prevent accidental triggers
        // Skip if keyboard is visible in PWA mode
        if (!autoScrollEnabled && !autoScrollTimeoutRef.current && !(isPWA && keyboardOffset > 0)) {
          autoScrollTimeoutRef.current = setTimeout(() => {
            // Double-check keyboard isn't visible when timeout fires
            if (isPWA && keyboardOffset > 0) {
              autoScrollTimeoutRef.current = null;
              return;
            }
            
            if (chatContainerRef.current) {
              const { scrollTop: currentScrollTop, scrollHeight: currentScrollHeight, clientHeight: currentClientHeight } = chatContainerRef.current;
              const currentDistanceFromBottom = currentScrollHeight - currentScrollTop - currentClientHeight;
              // Double-check user is still at bottom
              if (currentDistanceFromBottom <= threshold) {
                setAutoScrollEnabled(true);
                homeDispatch({ field: 'autoScroll', value: true });
              }
            }
            autoScrollTimeoutRef.current = null;
          }, 1000); // Wait 1 second before re-enabling
        }
      }

      lastScrollTop.current = scrollTop;
    }, 100); // 100ms debounce
  }, [autoScrollEnabled, homeDispatch, messageIsStreaming, isPWA, keyboardOffset]);

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

    chatContainerRef.current?.scrollTo({
      top: chatContainerRef.current.scrollHeight,
      behavior: 'smooth',
    });
    setAutoScrollEnabled(true);
    setShowScrollDownButton(false);
    homeDispatch({ field: 'autoScroll', value: true });
  };

  const scrollDown = () => {
    // In PWA mode, don't auto-scroll when keyboard is appearing to prevent snap-to-bottom
    if (isPWA && keyboardOffset > 0) {
      return;
    }
    
    // Only scroll if auto-scroll is enabled and not manually scrolling
    if (autoScrollEnabled && !isUserScrolling.current && chatContainerRef.current) {
      // Use requestAnimationFrame for smoother scrolling
      requestAnimationFrame(() => {
        if (messagesEndRef.current && autoScrollEnabled) {
          messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
      });
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
    // Only auto-scroll for new messages, not conversation switches
    if (selectedConversation && selectedConversationRef.current?.id !== selectedConversation.id) {
      // Conversation changed - don't force scroll, let user decide
      setAutoScrollEnabled(false);
      setShowScrollDownButton(false);

      // Update the ref
      selectedConversationRef.current = selectedConversation;
    } else if (selectedConversation && autoScrollEnabled) {
      // Same conversation, new message - only scroll if auto-scroll is enabled
      // Skip if keyboard is visible in PWA mode
      if (isPWA && keyboardOffset > 0) {
        return;
      }
      
      const currentMessageCount = selectedConversation.messages.length;
      const previousMessageCount = selectedConversationRef.current?.messages.length || 0;

      if (currentMessageCount > previousMessageCount) {
        throttledScrollDown();
      }
    }

    selectedConversation &&
      setCurrentMessage(
        selectedConversation.messages[selectedConversation.messages.length - 2],
      );
  }, [selectedConversation, throttledScrollDown, autoScrollEnabled, isPWA, keyboardOffset]);

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
    };
  }, []);

  const hasMessages = Boolean(selectedConversation?.messages?.length);

  return (
    <div
      className="relative flex h-screen flex-col bg-bg-secondary transition-colors duration-300 ease-in-out dark:bg-dark-bg-primary"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        height: isPWA && keyboardOffset > 0 
          ? `calc(100vh - ${keyboardOffset}px)` 
          : viewportHeight > 0 ? `${viewportHeight}px` : '100vh',
        // Use fixed positioning but adjust for iOS keyboard
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: isPWA ? `${keyboardOffset}px` : 0,
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

            // Clear any pending auto-scroll timeouts when user starts touching
            if (autoScrollTimeoutRef.current) {
              clearTimeout(autoScrollTimeoutRef.current);
              autoScrollTimeoutRef.current = null;
            }
          }}
          onTouchMove={(e) => {
            const touchY = e.touches[0].clientY;
            const deltaY = lastTouchY.current - touchY;

            // If scrolling up significantly (more than 10px), disable auto-scroll
            if (deltaY > 10 && autoScrollEnabled) {
              setAutoScrollEnabled(false);
              homeDispatch({ field: 'autoScroll', value: false });
              setShowScrollDownButton(true);
            }
            lastTouchY.current = touchY;
          }}
          onTouchEnd={() => {
            // Delay marking as not scrolling to prevent race conditions
            setTimeout(() => {
              isUserScrolling.current = false;
            }, 150);
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
          <div className="mx-auto flex h-full w-full max-w-5xl flex-col responsive-px pb-0 pt-4 sm:pt-6">
            {hasMessages ? (
              <div className="flex flex-col space-y-3 sm:space-y-4 min-w-0">
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
            {/* Responsive: 80px on mobile (accounts for input), 64px on desktop */}
            {/* In PWA mode, add extra space for keyboard offset */}
            <div 
              className="shrink-0" 
              ref={messagesEndRef}
              style={{
                height: isPWA && keyboardOffset > 0 
                  ? `calc(5rem + ${keyboardOffset}px)` 
                  : isMobile() ? '5rem' : '4rem'
              }}
            />
          </div>
        </div>

        {/* Scroll down button with auto-scroll indicator */}
        {showScrollDownButton && (
          <div className="absolute bottom-4 right-4 flex items-center gap-2">
            {!autoScrollEnabled && (
              <div className="px-3 py-1.5 rounded-full apple-glass backdrop-blur-xl border border-white/20 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.24)] text-xs text-neutral-600 dark:text-white/60">
                Auto-scroll paused
              </div>
            )}
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
        <div className="mx-auto max-w-5xl responsive-px pb-6 pt-3 md:pb-6 md:pt-3"
          style={{
            // Additional padding when keyboard is visible
            paddingBottom: isKeyboardVisible ? 'max(24px, env(safe-area-inset-bottom))' : 'max(24px, env(safe-area-inset-bottom))',
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
