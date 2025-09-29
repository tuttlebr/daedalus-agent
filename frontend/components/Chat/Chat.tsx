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
import { ChatBody, Conversation, Message } from '@/types/chat';
import HomeContext from '@/pages/api/home/home.context';
import { ChatInput } from './ChatInput';
import { ChatLoader } from './ChatLoader';
import { MemoizedChatMessage } from './MemoizedChatMessage';
import { cleanMessagesForLLM, processMessageImages } from '@/utils/app/imageHandler';

import { v4 as uuidv4 } from 'uuid';
import { InteractionModal } from '@/components/Chat/ChatInteractionMessage';
import { webSocketMessageTypes } from '@/utils/app/const';
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
      webSocketConnected,
      webSocketMode,
      webSocketURL,
      webSocketSchema,
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

  const [modalOpen, setModalOpen] = useState(false);
  const [interactionMessage, setInteractionMessage] = useState(null);
  const webSocketRef = useRef(null);
  const webSocketConnectedRef = useRef(false);
  const webSocketModeRef = useRef(sessionStorage.getItem('webSocketMode') === 'false' ? false : webSocketMode);
  let websocketLoadingToastId = null;
  const lastScrollTop = useRef(0); // Store last known scroll position

  // Add these variables near the top of your component
  const isUserInitiatedScroll = useRef(false);
  const scrollTimeout = useRef(null);


  const openModal = (data : any = {}) => {
    setInteractionMessage(data);
    setModalOpen(true);
  };

  const handleUserInteraction = ({interactionMessage = {}, userResponse = ''} : any) => {
    // todo send user input to websocket server as user response to interaction message
    // console.log("User response:", userResponse);
    const wsMessage = {
      type: webSocketMessageTypes.userInteractionMessage,
      id: uuidv4(), //new id for every new message
      thread_id: interactionMessage?.thread_id, // same thread_id from interaction message received
      parent_id: interactionMessage?.parent_id, // same parent_id from interaction message received
      username: user?.username || 'anon',
      content: {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: userResponse
              }
            ]
          }
        ]
      },
      timestamp: new Date().toISOString(),
    };
    console.log('sending user response for interaction message via websocket', wsMessage)
    webSocketRef?.current?.send(JSON.stringify(wsMessage));
  };

  useEffect(() => {
    selectedConversationRef.current = selectedConversation;
  }, [selectedConversation]);

  useEffect(() => {
    if (webSocketModeRef?.current && !webSocketConnectedRef.current) {
      connectWebSocket();
    }

    // todo cancel ongoing connection attempts
    else {
      toast.dismiss(websocketLoadingToastId);
    }

    return () => {
      if (webSocketRef?.current) {
        webSocketRef?.current?.close();
        webSocketConnectedRef.current = false;
      }
    };
  }, [webSocketModeRef?.current, webSocketURL]);

  const connectWebSocket = async (retryCount = 0) => {

    const maxRetries = 3;
    const retryDelay = 1000; // 1-second delay between retries

    if (!(sessionStorage.getItem('webSocketURL') || webSocketURL)) {
      toast.error("Please set a valid WebSocket server in settings");
      return false;
    }

    return new Promise((resolve) => {
      const ws = new WebSocket((sessionStorage.getItem('webSocketURL') || webSocketURL));

      websocketLoadingToastId = toast.loading(
        "WebSocket is not connected, trying to connect...",
        { id: "websocketLoadingToastId" }
      );

      ws.onopen = () => {

        toast.success("Connected to " + (sessionStorage.getItem('webSocketURL') || webSocketURL), {
          id: "websocketSuccessToastId",
        });
        toast.dismiss(websocketLoadingToastId);

        // using ref due to usecallback for handlesend which will be recreated during next render when dependency array changes
        // so values inside of are still one and be updated after next render
        // so we'll not see any changes to websocket (state variable) or webSocketConnected (context variable) changes while the function is executing
        webSocketConnectedRef.current = true;
        homeDispatch({ field: "webSocketConnected", value: true });
        webSocketRef.current = ws;
        resolve(true); // Resolve true only when connected
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
      };

      ws.onclose = async () => {
        if (retryCount < maxRetries) {
          retryCount++;

          // Retry and capture the result
          if(webSocketModeRef?.current) {
             // Wait for retry delay
            await new Promise((res) => setTimeout(res, retryDelay));
            console.log(`Retrying connection... Attempt ${retryCount}`);
            const success = await connectWebSocket(retryCount);
            resolve(success);
          }
        } else {
          // Only resolve(false) after all retries fail
          console.log("WebSocket connection failed after retries.");
          homeDispatch({ field: "webSocketConnected", value: false });
          webSocketConnectedRef.current = false;
          homeDispatch({ field: "loading", value: false });
          homeDispatch({ field: "messageIsStreaming", value: false });
          toast.dismiss(websocketLoadingToastId);
          toast.error("WebSocket connection failed.", {
            id: "websocketErrorToastId",
          });
          resolve(false);
        }
      };

      ws.onerror = (error) => {
        console.log("WebSocket connection error");
        homeDispatch({ field: "webSocketConnected", value: false });
        webSocketConnectedRef.current = false;
        homeDispatch({ field: "loading", value: false });
        homeDispatch({ field: "messageIsStreaming", value: false });
        ws.close(); // Ensure the WebSocket is closed on error
      };
    });
  };


  // Re-attach the WebSocket handler when intermediateStepOverride changes because we need updated value from settings
  useEffect(() => {
    if (webSocketRef.current) {
      webSocketRef.current.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
      };
    }
  }, [intermediateStepOverride]);


  const handleWebSocketMessage = (message: any) => {
    // console.log('Received message via websocket', message);

    // todo ingore messages that are coming after stop conversation
    // idea - add a field in stored messsage that indicates if its been cancelled

    // stop loading after receiving a message
    homeDispatch({ field: 'loading', value: false });
    if(message?.status === 'complete') {
      // stop streaming status after receiving a message with status completed -> END
      // to show the message on UI and scroll to the bottom after 500ms delay
      setTimeout(() => {
        homeDispatch({ field: 'messageIsStreaming', value: false });
      }, 200);
    }

    // handling human in the loop messages
    if(message?.type === webSocketMessageTypes.systemInteractionMessage) {
      openModal(message)
    }

    if(sessionStorage.getItem('enableIntermediateSteps') === 'false' && message?.type === webSocketMessageTypes.systemIntermediateMessage) {
      console.log('ignoring intermediate steps');
      return
    }

    // handle error messages
    if(message?.type === 'error') {
      message.content.text = 'Something went wrong. Please try again. \n\n' + `<details id=${message?.id}><summary></summary>${JSON.stringify(message?.content)}</details>`
      // to show the message on UI and scroll to the bottom after 500ms delay
      setTimeout(() => {
        homeDispatch({ field: 'messageIsStreaming', value: false });
      }, 200);
    }

    // updating conversation with new message
    let updatedMessages
    // Use the selectedConversation from React state (via ref) instead of sessionStorage
    // This ensures we have the full conversation history, not the truncated version
    let currentSelectedConversation = selectedConversationRef.current
    let currentConversations = conversations

    // logic
    // if this is the first message (of the assistant response to user message), then add the message to the conversation as 'assistant' message
    // else append the message to the exisiting assistant message (part of the stream appending)
    // look through the conversation messages and find if a assistant message has id = parentId
    const isLastMessageFromAssistant = currentSelectedConversation?.messages && currentSelectedConversation.messages.length > 0 && currentSelectedConversation.messages[currentSelectedConversation.messages.length - 1].role === 'assistant'
    if(isLastMessageFromAssistant) {
      // console.log('found assistant message, appending to it')
      // update the assistant message inside selectedConversation
      updatedMessages = currentSelectedConversation?.messages?.map((msg, idx) => {
        if (msg.role === 'assistant' && idx === currentSelectedConversation?.messages?.length - 1) {
          // do this only for response token
          let updatedContent = msg.content || '';
          if(message?.type === webSocketMessageTypes.systemResponseMessage) {
            updatedContent = updatedContent + (message?.content?.text || '');
          }

          // find index for new message
          // it can be the length of the intermediate messages last one
          let index = msg?.intermediateSteps?.length || 0;
          message = {...message, index}

          // process IntermediateSteps
          let processedIntermediateSteps = (message?.type === webSocketMessageTypes.systemIntermediateMessage)
            ? processIntermediateMessage(msg.intermediateSteps || [], message, sessionStorage.getItem('intermediateStepOverride') === 'false' ? false : intermediateStepOverride)
            : msg.intermediateSteps || [];

          if(message?.type === webSocketMessageTypes.systemInteractionMessage){
            msg.humanInteractionMessages = msg.humanInteractionMessages || [];
            msg.humanInteractionMessages.push(message);
          }
          if(message?.type === 'error') {
            msg.errorMessages = msg.errorMessages || [];
            msg.errorMessages.push(message);
          }

          // update the assistant message with new content and processed intermediate steps
          return {
            ...msg,
            content: updatedContent,
            intermediateSteps: processedIntermediateSteps,
            humanInteractionMessages: msg.humanInteractionMessages || [],
            errorMessages: msg.errorMessages || []
          };
        }
        return msg;
      });
    } else {
      // console.log('didnt find assistant message, adding new one (first chunk of response)')
      // add the new message to the conversation as 'assistant' message
      updatedMessages = [
        ...(currentSelectedConversation?.messages || []),
        {
          role: 'assistant',
          id: message?.id,
          parentId: message?.parent_id,
          content: message?.content?.text || '',
          intermediateSteps: (message?.type === webSocketMessageTypes.systemIntermediateMessage) ? [{...message, index: 0}] : [],
          humanInteractionMessages: (message?.type === webSocketMessageTypes.systemInteractionMessage) ? [message] : [],
          errorMessages: message?.type === 'error' ? [message] : []
        },
      ];
    }

    // update the conversation
    let updatedConversation = {
      ...currentSelectedConversation,
      messages: updatedMessages,
      id: currentSelectedConversation?.id || '',
    };
    homeDispatch({
      field: 'selectedConversation',
      value: updatedConversation,
    });

    // save the conversation to session storage
    saveConversation(updatedConversation);

    // update the conversations
    const updatedConversations = currentConversations?.map(
      (conversation) => {
        if (conversation.id === updatedConversation?.id) {
          return updatedConversation;
        }
        return conversation;
      },
    ) || [];

    if (updatedConversations.length === 0) {
      updatedConversations.push(updatedConversation);
    }
    homeDispatch({
      field: 'conversations',
      value: updatedConversations,
    });

    // save the conversations to session storage
    saveConversations(updatedConversations);
  };


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

        // Store processed conversation for both websocket and HTTP
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

        // websocket connection chat request
        if (webSocketModeRef?.current) {
          if (!webSocketConnectedRef?.current) {
            const connected = await connectWebSocket();
            if (!connected) {
              console.log("WebSocket connection failed.");
              homeDispatch({ field: "loading", value: false });
              homeDispatch({ field: "messageIsStreaming", value: false });
              return;
            }
            else {
              console.log("WebSocket connected successfully!, Resend the query");
              handleSend(message, 1)
              return
            }

          }
          toast.dismiss()


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

          const wsMessagesSource = updatedConversation?.messages || [];
          // Clean messages before sending via WebSocket
          const cleanedMessages = cleanMessagesForLLM(wsMessagesSource);
          const chatMessages = cleanedMessages.map((message: Message) => ({
            role: message.role,
            content: [
              {
                type: 'text',
                text: (typeof message?.content === 'string' ? message.content.trim() : '') || '',
              },
            ],
          }));

          const wsMessage = {
            type: webSocketMessageTypes.userMessage,
            schema_type: sessionStorage.getItem('webSocketSchema') || webSocketSchema,
            id: message?.id,
            thread_id: selectedConversation.id,
            username: user?.username || 'anon',
            content: {
              messages: chatMessages
            },
            timestamp: new Date().toISOString(),
          };
          // console.log('Sent message via websocket', wsMessage)
          webSocketRef?.current?.send(JSON.stringify(wsMessage));
          return
        }

        // cleaning up messages to fit the request payload and remove image data
        const messagesCleaned = cleanMessagesForLLM(updatedConversation.messages);

        const chatBody: ChatBody = {
          messages: messagesCleaned,
          chatCompletionURL: sessionStorage.getItem('chatCompletionURL') || chatCompletionURL,
          additionalProps: {
            enableIntermediateSteps: sessionStorage.getItem('enableIntermediateSteps')
            ? sessionStorage.getItem('enableIntermediateSteps') === 'true'
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
                  processedIntermediateSteps = processIntermediateMessage(processedIntermediateSteps, step, sessionStorage.getItem('intermediateStepOverride') === 'false' ? false : intermediateStepOverride )
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
                        updatedIntermediateSteps = processIntermediateMessage(updatedIntermediateSteps, step, sessionStorage.getItem('intermediateStepOverride') === 'false' ? false : intermediateStepOverride)
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
      webSocketConnected,
      webSocketSchema,
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
          <ChatHeader webSocketModeRef={webSocketModeRef} />
          <div className="flex flex-col gap-4 sm:gap-3 md:gap-2">
            {selectedConversation?.messages.map((message, index) => (
              <MemoizedChatMessage
                key={index}
                message={message}
                messageIndex={index}
                onEdit={(editedMessage) => {
                  setCurrentMessage(editedMessage);
                  handleSend(
                    editedMessage,
                    selectedConversation?.messages.length - index,
                  );
                }}
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
        <InteractionModal isOpen={modalOpen} interactionMessage={interactionMessage} onClose={() => setModalOpen(false)} onSubmit={handleUserInteraction} />
      </>
    </div>
  );
};
Chat.displayName = 'Chat';
