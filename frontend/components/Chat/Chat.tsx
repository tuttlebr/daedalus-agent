'use client';
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
} from '@/utils/app/helper';
import { throttle } from '@/utils/data/throttle';
import { getUserSessionItem } from '@/utils/app/storage';
import { ChatBody, Conversation, Message } from '@/types/chat';
import HomeContext from '@/pages/api/home/home.context';
import { ChatInput } from './ChatInput';
import { ChatLoader } from './ChatLoader';
import { MemoizedChatMessage } from './MemoizedChatMessage';
import { cleanMessagesForLLM, processMessageImages } from '@/utils/app/imageHandler';

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
  const [showSettings, setShowSettings] = useState<boolean>(false);
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
  const scrollTimeout = useRef(null);

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
              let messages = chunkValue.match(/<intermediatestep>(.*?)<\/intermediatestep>/gs) || [];
              for (const message of messages) {
                try {
                  const jsonString = message.replace('<intermediatestep>', '').replace('</intermediatestep>', '').trim();
                  let rawIntermediateMessage = JSON.parse(jsonString);
                  // handle intermediate data
                  if (rawIntermediateMessage?.type === 'system_intermediate') {
                    rawIntermediateSteps.push(rawIntermediateMessage);
                  }
                } catch (error) {
                  // console.log('Stream response parse error:', error.message);
                }
              }

              // if the received chunk contains rawIntermediateSteps then remove them from the chunkValue
              if (messages.length > 0) {
                chunkValue = chunkValue.replace(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g, '');
              }

              text = text + chunkValue;

              homeDispatch({ field: 'loading', value: false });
              if (isFirst) {
                isFirst = false;

                // loop through rawIntermediateSteps and add them to the processedIntermediateSteps
                let processedIntermediateSteps = []
                rawIntermediateSteps.forEach((step) => {
                  // Use user-specific storage key to prevent data leakage between users
                  processedIntermediateSteps = processIntermediateMessage(processedIntermediateSteps, step, getUserSessionItem('intermediateStepOverride') === 'false' ? false : intermediateStepOverride )
                })

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
                      let updatedIntermediateSteps = [...message?.intermediateSteps]
                      rawIntermediateSteps.forEach((step) => {
                        // Use user-specific storage key to prevent data leakage between users
                        updatedIntermediateSteps = processIntermediateMessage(updatedIntermediateSteps, step, getUserSessionItem('intermediateStepOverride') === 'false' ? false : intermediateStepOverride)
                      })

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
            const updatedMessages: Message[] = [
              ...updatedConversation.messages,
              { role: 'assistant', content: answer },
            ];
            updatedConversation = {
              ...updatedConversation,
              messages: updatedMessages,
            };
            homeDispatch({
              field: 'selectedConversation',
              value: updateConversation,
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
        } catch (error) {
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
    // Enable auto-scroll after user clicks scroll down, assuming the user wants to auto-scroll
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
        if (entry.isIntersecting) {
          textareaRef.current?.focus();
        }

        // Only auto-scroll if we're streaming and auto-scroll is enabled
        if (autoScrollEnabled && messageIsStreaming) {
          requestAnimationFrame(() => {
            messagesEndRef.current?.scrollIntoView({
              behavior: 'smooth',
              block: 'end',
            });
          });
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

  return (
    <div
      className="safari-safe-area relative flex-1 overflow-hidden bg-white dark:bg-dark-bg-primary transition-all duration-300 ease-in-out"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)'
      }}
    >
      <>
        <div
          className="max-h-full overflow-x-hidden bg-white dark:bg-dark-bg-primary"
          ref={chatContainerRef}
          onScroll={handleScroll}
          style={{
            // Ensure consistent background
            minHeight: '100%',
            paddingLeft: 'calc(env(safe-area-inset-left) + 1rem)',
            paddingRight: 'calc(env(safe-area-inset-right) + 1rem)',
            paddingBottom: '1.5rem'
          }}
        >
          <ChatHeader />
          <div className="flex flex-col gap-4 sm:gap-3 md:gap-2">
            {selectedConversation?.messages.map((message, index) => (
              <MemoizedChatMessage
                key={index}
                message={message}
                messageIndex={index}
              />
            ))}
          </div>
          {loading && <ChatLoader statusUpdateText={`Thinking...`} />}
          <div
            className="h-[162px] bg-white dark:bg-dark-bg-primary"
            ref={messagesEndRef}
          >
          </div>
        </div>
        <ChatInput
          textareaRef={textareaRef}
          onSend={(message) => {
            setCurrentMessage(message);
            handleSend(message, 0);
          }}
          onScrollDownClick={handleScrollDown}
          onRegenerate={() => {
            if (currentMessage && currentMessage?.role === 'user') {
              handleSend(currentMessage, 0);
            } else {
              const lastUserMessage = fetchLastMessage(
                {messages: selectedConversation?.messages, role: 'user'}
              );
              lastUserMessage && handleSend(lastUserMessage, 1);
            }
          }}
          showScrollDownButton={showScrollDownButton}
          controller={controllerRef}
        />
      </>
    </div>
  );
};
Chat.displayName = 'Chat';
