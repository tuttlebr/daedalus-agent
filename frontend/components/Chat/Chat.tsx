'use client';
import { IconArrowDown } from '@tabler/icons-react';
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
  processIntermediateMessage,
  trimIntermediateSteps,
} from '@/utils/app/helper';
import { throttle } from '@/utils/data/throttle';
import { getUserSessionItem } from '@/utils/app/storage';
import { ChatBody, Conversation, Message } from '@/types/chat';
import HomeContext from '@/pages/api/home/home.context';
import { ChatInput } from './ChatInput';
import { ChatLoader } from './ChatLoader';
import { MemoizedChatMessage } from './MemoizedChatMessage';
import { cleanMessagesForLLM, processMessageImages } from '@/utils/app/imageHandler';
import { GalaxyAnimation } from '@/components/GalaxyAnimation';

import { v4 as uuidv4 } from 'uuid';
import { ChatHeader } from './ChatHeader';
import { useAuth } from '@/components/Auth/AuthProvider';

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
      enableIntermediateSteps
    },
    handleUpdateConversation,
    dispatch: homeDispatch,
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

  // Add these variables near the top of your component
  const isUserInitiatedScroll = useRef(false);
  const scrollTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    selectedConversationRef.current = selectedConversation;
  }, [selectedConversation]);

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

        const chatBody: ChatBody = {
          messages: messagesCleaned,
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
            let partialIntermediateStep = ''; // Add this to store partial chunks
            let partialToolCall = '';
            let partialTagBuffer = ''; // Buffer for partial tag names
            while (!done) {
              const { value, done: doneReading } = await reader.read();
              done = doneReading;
              let chunkValue = decoder.decode(value);
              counter++;

              // First, handle any partial chunk from previous iteration
              if (partialIntermediateStep) {
                chunkValue = partialIntermediateStep + chunkValue;
                partialIntermediateStep = "";
              }

              // Handle partial tag names from previous chunk
              if (partialTagBuffer) {
                chunkValue = partialTagBuffer + chunkValue;
                partialTagBuffer = "";
              }

              // Check for partial tags at the END of chunk more aggressively
              // Match any trailing partial opening/closing tag: <, <i, <in, <int, <inte, etc.
              // Also match partial closing tags: </, </i, </in, etc.
              const tagPrefixes = [
                '</intermediatestep', '</intermediateste', '</intermediateste', '</intermediates',
                '</intermediate', '</intermediat', '</intermedia', '</intermedi', '</intermed',
                '</interm', '</inter', '</inte', '</int', '</in', '</i', '</',
                '<intermediatestep', '<intermediateste', '<intermediateste', '<intermediates',
                '<intermediate', '<intermediat', '<intermedia', '<intermedi', '<intermed',
                '<interm', '<inter', '<inte', '<int', '<in', '<i', '<'
              ];

              for (const prefix of tagPrefixes) {
                if (chunkValue.endsWith(prefix)) {
                  partialTagBuffer = prefix;
                  chunkValue = chunkValue.substring(0, chunkValue.length - prefix.length);
                  break;
                }
              }

              // Remove any malformed tag fragments that slipped through (anywhere in the chunk)
              chunkValue = chunkValue.replace(/<\/?i?n?t?e?r?m?e?d?i?a?t?e?s?t?e?p?(?![>])/g, '');

              // Check for incomplete tags
              const openingTagIndex = chunkValue.lastIndexOf("<intermediatestep>");
              const closingTagIndex = chunkValue.lastIndexOf("</intermediatestep>");

              // If we have an opening tag without a closing tag (or closing tag comes before opening)
              if (openingTagIndex > closingTagIndex) {
                // Store the partial chunk for the next iteration
                partialIntermediateStep = chunkValue.substring(openingTagIndex);
                // Remove the partial chunk from current processing
                chunkValue = chunkValue.substring(0, openingTagIndex);
              }

              // Process complete intermediate steps
              let rawIntermediateSteps = [];
              let messages = chunkValue.match(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g) || [];
              for (const message of messages) {
                try {
                  const jsonString = message.replace('<intermediatestep>', '').replace('</intermediatestep>', '').trim();
                  let rawIntermediateMessage = JSON.parse(jsonString);
                  // handle intermediate data
                  if (rawIntermediateMessage?.type === 'system_intermediate') {
                    rawIntermediateSteps.push(rawIntermediateMessage);
                  }
                } catch (error) {
                  console.error('Failed to parse intermediate step JSON:', error);
                  // Still continue - we'll remove the tags below to prevent raw display
                }
              }

              // ALWAYS remove intermediate step tags from visible content, even if parsing failed
              // This prevents raw JSON from being displayed to users
              chunkValue = chunkValue.replace(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g, '');

              // Handle react_agent tool-call artifacts: accumulate partial <TOOLCALL> blocks across chunks
              const toolOpenIdx = chunkValue.lastIndexOf('<TOOLCALL>');
              const toolCloseIdx = chunkValue.lastIndexOf('</TOOLCALL>');
              if (toolOpenIdx > toolCloseIdx) {
                partialToolCall = chunkValue.substring(toolOpenIdx);
                chunkValue = chunkValue.substring(0, toolOpenIdx);
              }
              if (partialToolCall) {
                const maybeCloseIdx = chunkValue.indexOf('</TOOLCALL>');
                if (maybeCloseIdx !== -1) {
                  // Complete the partial
                  const completed = partialToolCall + chunkValue.substring(0, maybeCloseIdx + '</TOOLCALL>'.length);
                  chunkValue = chunkValue.substring(maybeCloseIdx + '</TOOLCALL>'.length);
                  partialToolCall = '';
                  // Prepend for parsing below
                  chunkValue = completed + chunkValue;
                }
              }

              // Extract complete <TOOLCALL> blocks and convert them to intermediate steps
              const toolCallMatches = chunkValue.match(/<TOOLCALL>[\s\S]*?<\/TOOLCALL>/g) || [];
              if (toolCallMatches.length > 0) {
                for (const m of toolCallMatches) {
                  try {
                    const inner = m.replace('<TOOLCALL>', '').replace('</TOOLCALL>', '').trim();
                    let pretty = inner;
                    try {
                      const obj = JSON.parse(inner);
                      pretty = JSON.stringify(obj, null, 2);
                    } catch (_) {
                      // keep raw inner if not valid JSON
                    }
                    const intermediate_message = {
                      id: `toolcall-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
                      status: 'completed',
                      error: '',
                      type: 'system_intermediate',
                      parent_id: 'agent_tool',
                      content: {
                        name: 'Tool Call',
                        payload: pretty,
                      },
                      time_stamp: Date.now(),
                      index: -1,
                    };
                    rawIntermediateSteps.push(intermediate_message);
                  } catch (_) {
                    // ignore malformed blocks
                  }
                }
                // Remove all TOOLCALL blocks from visible content
                chunkValue = chunkValue.replace(/<TOOLCALL>[\s\S]*?<\/TOOLCALL>/g, '');
              }

              // Hide orchestration scaffolding from react_agent outputs
              // Remove Thought/Action/Action Input/Observation lines; keep Final Answer content
              chunkValue = chunkValue.replace(/^(Thought:|Action:|Action Input:|Observation:).*$/gm, '');
              chunkValue = chunkValue.replace(/\bFinal Answer:\s*/g, '');

              // AGGRESSIVE PRE-FILTER: Remove verbose intermediate step patterns before JSON parsing
              // This catches system prompts and verbose payloads that shouldn't be displayed
              const verbosePatterns = [
                'You are an expert reasoning model',
                'Given the following input and a list of available tools',
                'Answer the following questions as best you can',
                'HumanMessage(content=',
                'SystemMessage(content=',
                'FieldInfo(annotation=',
                'Arguments must be provided as a valid JSON object',
                'Please provide a detailed step-by-step plan',
                'Determining the most suitable tools for each task',
                'IMPORTANT — Real-time and Dates Policy'
              ];

              // If chunk contains verbose patterns, it's likely a system intermediate step - filter it out
              let shouldFilterChunk = false;
              for (const pattern of verbosePatterns) {
                if (chunkValue.includes(pattern)) {
                  shouldFilterChunk = true;
                  console.log('Filtering verbose chunk containing pattern:', pattern.substring(0, 50));
                  break;
                }
              }

              // Skip this entire chunk if it's verbose
              if (shouldFilterChunk) {
                chunkValue = '';
              } else {
                // Filter out any raw JSON objects that look like intermediate steps
                // This catches intermediate steps that aren't wrapped in tags
                try {
                  // Find potential JSON objects with system_intermediate type
                  let filtered = chunkValue;
                  let startIdx = 0;

                  while (true) {
                    const jsonStart = filtered.indexOf('{"id":"', startIdx);
                    if (jsonStart === -1) break;

                    // Try to find the matching closing brace by counting braces
                    let braceCount = 0;
                    let jsonEnd = -1;
                    let inString = false;
                    let escapeNext = false;

                    for (let i = jsonStart; i < filtered.length; i++) {
                      const char = filtered[i];

                      if (escapeNext) {
                        escapeNext = false;
                        continue;
                      }

                      if (char === '\\') {
                        escapeNext = true;
                        continue;
                      }

                      if (char === '"') {
                        inString = !inString;
                        continue;
                      }

                      if (!inString) {
                        if (char === '{') braceCount++;
                        else if (char === '}') {
                          braceCount--;
                          if (braceCount === 0) {
                            jsonEnd = i + 1;
                            break;
                          }
                        }
                      }
                    }

                    if (jsonEnd !== -1) {
                      const potentialJson = filtered.substring(jsonStart, jsonEnd);
                      try {
                        const parsed = JSON.parse(potentialJson);
                        if (parsed.type === 'system_intermediate') {
                          // Remove this JSON object from the output
                          console.log('Filtered system_intermediate JSON from chunk');
                          filtered = filtered.substring(0, jsonStart) + filtered.substring(jsonEnd);
                          startIdx = jsonStart; // Continue searching from same position
                          continue;
                        }
                      } catch (e) {
                        // Not valid JSON, skip past it
                      }
                    }

                    startIdx = jsonStart + 1;
                  }

                  chunkValue = filtered;
                } catch (e) {
                  console.error('Error filtering intermediate steps:', e);
                }
              }

              text = text + chunkValue;

              homeDispatch({ field: 'loading', value: false });
              if (isFirst) {
                isFirst = false;

                // loop through rawIntermediateSteps and add them to the processedIntermediateSteps
                let processedIntermediateSteps: any[] = []
                rawIntermediateSteps.forEach((step) => {
                  // Use user-specific storage key to prevent data leakage between users
                  processedIntermediateSteps = processIntermediateMessage(processedIntermediateSteps, step, getUserSessionItem('intermediateStepOverride') === 'false' ? false : intermediateStepOverride)
                })

                // Trim intermediate steps to prevent memory bloat
                processedIntermediateSteps = trimIntermediateSteps(processedIntermediateSteps);

                // update the message
                const updatedMessages: Message[] = [
                  ...updatedConversation.messages,
                  {
                    role: 'assistant',
                    content: text, // main response content without intermediate steps
                    intermediateSteps: [...processedIntermediateSteps], // intermediate steps
                  },
                ];

                updatedConversation = {
                  ...updatedConversation,
                  messages: updatedMessages,
                };

                homeDispatch({
                  field: 'selectedConversation',
                  value: updatedConversation,
                });
              } else {

                const updatedMessages: Message[] =
                  updatedConversation.messages.map((message, index) => {
                    if (index === updatedConversation.messages.length - 1) {
                      // process intermediate steps
                      // need to loop through raw rawIntermediateSteps and add them to the updatedIntermediateSteps
                      let updatedIntermediateSteps: any[] = [...(message?.intermediateSteps || [])]
                      rawIntermediateSteps.forEach((step) => {
                        // Use user-specific storage key to prevent data leakage between users
                        updatedIntermediateSteps = processIntermediateMessage(updatedIntermediateSteps, step, getUserSessionItem('intermediateStepOverride') === 'false' ? false : intermediateStepOverride)
                      })

                      // Trim intermediate steps to prevent memory bloat
                      updatedIntermediateSteps = trimIntermediateSteps(updatedIntermediateSteps);

                      // update the message
                      const msg = {
                        ...message,
                        content: text, // main response content
                        intermediateSteps: updatedIntermediateSteps // intermediate steps
                      };
                      return msg
                    }
                    return message;
                  });
                updatedConversation = {
                  ...updatedConversation,
                  messages: updatedMessages,
                };
                homeDispatch({
                  field: 'selectedConversation',
                  value: updatedConversation,
                });
              }
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
      setAutoScrollEnabled(true);
      setShowScrollDownButton(false);
      homeDispatch({ field: 'autoScroll', value: true });
    }
  }, [messageIsStreaming]);

  // Add an effect to set up wheel and touchmove event listeners
  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;

    // Function to handle user input events (mouse wheel, touch)
    const handleUserInput = () => {
      // Mark this as user-initiated scrolling
      isUserInitiatedScroll.current = true;

      // Reset the flag after a short delay
      if (scrollTimeout.current) {
        clearTimeout(scrollTimeout.current);
      }
      scrollTimeout.current = setTimeout(() => {
        isUserInitiatedScroll.current = false;
      }, 200);
    };

    // Add event listeners for user interactions
    container.addEventListener('wheel', handleUserInput, { passive: true });
    container.addEventListener('touchmove', handleUserInput, { passive: true });

    return () => {
      // Clean up
      container.removeEventListener('wheel', handleUserInput);
      container.removeEventListener('touchmove', handleUserInput);
      if (scrollTimeout.current) {
        clearTimeout(scrollTimeout.current);
      }
    };
  }, [chatContainerRef.current]); // Only re-run if the container ref changes

  // Now modify your handleScroll function to use this flag
  const handleScroll = useCallback(() => {
    if (!chatContainerRef.current || !isUserInitiatedScroll.current) return;

    const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
    const isScrollingUp = scrollTop < lastScrollTop.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 20;

    // Only disable auto-scroll if it's a user-initiated upward scroll
    if (isScrollingUp && autoScrollEnabled && messageIsStreaming) {
      setAutoScrollEnabled(false);
      homeDispatch({ field: 'autoScroll', value: false });
      setShowScrollDownButton(true);
    }

    // Re-enable auto-scroll if user scrolls to bottom
    if (isAtBottom && !autoScrollEnabled) {
      setAutoScrollEnabled(true);
      homeDispatch({ field: 'autoScroll', value: true });
      setShowScrollDownButton(false);
    }

    lastScrollTop.current = scrollTop;
  }, [autoScrollEnabled, messageIsStreaming]);

  const handleScrollDown = () => {
    chatContainerRef.current?.scrollTo({
      top: chatContainerRef.current.scrollHeight,
      behavior: 'smooth',
    });
    setAutoScrollEnabled(true);
    homeDispatch({ field: 'autoScroll', value: true });
  };

  const scrollDown = () => {
    if (autoScrollEnabled) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }

  const throttledScrollDown = throttle(scrollDown, 250);

  useEffect(() => {
    throttledScrollDown();
    selectedConversation &&
      setCurrentMessage(
        selectedConversation.messages[selectedConversation.messages.length - 2],
      );
  }, [selectedConversation, throttledScrollDown]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (autoScrollEnabled && messageIsStreaming) {
          if (entry.isIntersecting) {
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

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col bg-bg-secondary transition-colors duration-300 ease-in-out dark:bg-dark-bg-primary"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      <ChatHeader />
      <div className="relative flex flex-1 flex-col">
        <div
          className="flex-1 overflow-y-auto"
          ref={chatContainerRef}
          onScroll={handleScroll}
        >
          <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-4 pb-8 pt-6 sm:px-6 lg:px-8">
            {hasMessages ? (
              <div className="flex flex-col space-y-4 sm:space-y-5 min-w-0">
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
                <div className="flex items-center justify-center">
                  <GalaxyAnimation containerSize={220} />
                </div>
              </div>
            )}

            {loading && <ChatLoader statusUpdateText={`Thinking...`} />}

            <div className="h-16 shrink-0" ref={messagesEndRef} />
          </div>
        </div>

        {showScrollDownButton && (
          <button
            type="button"
            className="pointer-events-auto absolute bottom-[7.5rem] right-5 z-20 flex h-11 w-11 items-center justify-center rounded-full border border-neutral-200 bg-bg-primary text-text-primary shadow-md transition-colors duration-150 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:bg-dark-bg-tertiary dark:text-neutral-200 dark:hover:border-neutral-600"
            onClick={handleScrollDown}
            style={{
              marginBottom: 'env(safe-area-inset-bottom)'
            }}
            aria-label={t('Scroll to bottom') as unknown as string}
          >
            <IconArrowDown size={20} />
          </button>
        )}

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
        />
      </div>
    </div>
  );
};
Chat.displayName = 'Chat';
