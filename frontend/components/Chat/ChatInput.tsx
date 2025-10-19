import {
  IconArrowDown,
  IconMicrophone,
  IconPhoto,
  IconPlayerStop,
  IconPlayerStopFilled,
  IconRepeat,
  IconSend,
  IconTrash,
  IconCamera,
  IconPaperclip,
  IconX,
} from '@tabler/icons-react';
import {
  KeyboardEvent,
  MutableRefObject,
  Ref,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import type React from 'react';

import { useTranslation } from 'next-i18next';
import toast from 'react-hot-toast';

import { Message, Conversation } from '@/types/chat';
import { v4 as uuidv4 } from 'uuid';

import HomeContext from '@/pages/api/home/home.context';
import { compressImage } from '@/utils/app/helper';
import { appConfig } from '@/utils/app/const';
import { uploadImage, ImageReference } from '@/utils/app/imageHandler';
import { uploadPDF, PDFReference } from '@/utils/app/pdfHandler';
import { setUserSessionItem } from '@/utils/app/storage';
import { saveConversation, saveConversations } from '@/utils/app/conversation';
import { OptimizedImage } from './OptimizedImage';
import { VoiceRecorder } from './VoiceRecorder';
import { QuickActions } from './QuickActions';
import { QuickActionsPopup } from './QuickActionsPopup';


interface Props {
  onSend: (message: Message) => void;
  onRegenerate: () => void;
  onScrollDownClick: () => void;
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  showScrollDownButton: boolean;
  controller: MutableRefObject<AbortController>;
  onQuickActionsRegister?: (handlers: {
    onAttachFile: () => void;
    onTakePhoto: () => void;
    onStartVoice: () => void;
    onToggleDeepThought: () => void;
  }) => void;
}

export const ChatInput: React.FC<Props> = ({
  onSend,
  onScrollDownClick,
  textareaRef,
  showScrollDownButton,
  controller,
  onQuickActionsRegister,
}) => {
  const { t } = useTranslation('chat');

  const {
    state: { selectedConversation, messageIsStreaming, enableIntermediateSteps, conversations, useDeepThinker },
    dispatch: homeDispatch,
  } = useContext(HomeContext);

  // todo add the audio file
  const recordingStartSound = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      recordingStartSound.current = new Audio('audio/recording.wav');
    }
  }, []);

  const [content, setContent] = useState<string>('');
  const [isTyping, setIsTyping] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [inputFile, setInputFile] = useState<string | null>(null);
  const [inputFileExtension, setInputFileExtension] = useState('');
  const [inputFileContent, setInputFileContent] = useState('');
  const [inputFileContentCompressed, setInputFileContentCompressed] = useState('');
  const [imageRef, setImageRef] = useState<ImageReference | null>(null);
  const [pdfRef, setPdfRef] = useState<{ pdfId: string; sessionId: string } | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  const recognitionRef = useRef<any>(null);

  const triggerFileUpload = useCallback(() => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  }, []);

  const triggerPhotoUpload = useCallback(() => {
    if (photoInputRef.current) {
      photoInputRef.current.click();
    }
  }, []);

  const handleInputFileDelete = () => {
    setInputFile(null);
    setInputFileExtension('');
    setInputFileContent('');
    setInputFileContentCompressed('');
    setImageRef(null);
    setPdfRef(null);
  };

  const handleToggleDeepThinker = useCallback(() => {
    const nextValue = !useDeepThinker;
    homeDispatch({ field: 'useDeepThinker', value: nextValue });
    if (nextValue && !enableIntermediateSteps) {
      homeDispatch({ field: 'enableIntermediateSteps', value: true });
      setUserSessionItem('enableIntermediateSteps', 'true');
    }
  }, [homeDispatch, useDeepThinker, enableIntermediateSteps]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Reset the input value so the same file can be selected again if needed
      e.target.value = '';
      const reader = new FileReader();
      reader.onload = (loadEvent) => {
        const fullBase64String = (loadEvent.target?.result ?? null) as string | ArrayBuffer | null;
        processFile({ fullBase64String, file });
      };
      reader.readAsDataURL(file);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;

    setContent(value);
  };

  const processPDFInBackground = async (pdfRefData: any, filename: string) => {
    try {
      const response = await fetch('/api/pdf/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pdfRef: pdfRefData,
          filename: filename
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        console.error('Failed to process PDF:', result);
        toast.error('Failed to process PDF. Please try again.');
        return false;
      }

      console.log('PDF processed successfully:', result);
      toast.success('PDF uploaded successfully.');

      // Add an assistant message to the conversation to provide context
      if (selectedConversation) {
        const contentMessage = `Your PDF was uploaded successfully.`;

        const assistantMessage: Message = {
          id: uuidv4(),
          role: 'assistant',
          content: contentMessage
        };

        const updatedConversation = {
          ...selectedConversation,
          messages: [...selectedConversation.messages, assistantMessage]
        };

        homeDispatch({
          field: 'selectedConversation',
          value: updatedConversation
        });

        // Save conversation
        saveConversation(updatedConversation);

        // Update conversations list
        const updatedConversations = conversations.map((conv: Conversation) =>
          conv.id === selectedConversation.id ? updatedConversation : conv
        );

        homeDispatch({
          field: 'conversations',
          value: updatedConversations
        });

        saveConversations(updatedConversations);
      }

      return true;
    } catch (error) {
      console.error('Error processing PDF:', error);
      toast.error('Error processing PDF. Please try again.');
      return false;
    }
  };

  const handleStop = () => {
    if (controller.current) {
      controller.current.abort();
      controller.current = new AbortController();
    }
  };

  const handleSend = async () => {
    if (messageIsStreaming || isUploadingImage) {
      return;
    }

    // stop recognition if it's running
    if (isRecording && recognitionRef.current) {
      recognitionRef.current.stop();
      setIsRecording(false);
    }

    if (!content && !inputFile && !imageRef && !pdfRef) {
      alert(t('Please enter a message or attach a file'));
      return;
    }

    // Process PDF first if there is one
    if (pdfRef) {
      // Show processing message
      toast.loading('Processing PDF...', { id: 'pdf-processing' });

      const success = await processPDFInBackground(pdfRef, inputFile || 'document.pdf');

      // Dismiss loading toast
      toast.dismiss('pdf-processing');

      if (!success) {
        // Don't send the message if PDF processing failed
        return;
      }

      // If there is no additional user text, do not send a follow-up chat message.
      // The background processor already injected a simple confirmation.
      if (!content && !imageRef) {
        setContent('');
        setInputFile(null);
        setInputFileExtension('');
        setInputFileContent('');
        setInputFileContentCompressed('');
        setImageRef(null);
        setPdfRef(null);
        if (window.innerWidth < 640 && textareaRef && textareaRef.current) {
          textareaRef.current.blur();
        }
        return;
      }
    }

    // Store deep thinker mode in metadata instead of appending to content
    if (inputFile || imageRef || pdfRef) {
      const attachments = [];

      if (imageRef) {
        attachments.push({
          content: '', // Don't send base64 in the message
          type: 'image',
          imageRef: imageRef
        });
      }

      // Don't include PDF in attachments since it's already processed
      // if (pdfRef) {
      //   attachments.push({
      //     content: '', // Don't send base64 in the message
      //     type: 'pdf',
      //     pdfRef: pdfRef
      //   });
      // }

      // Send message with only image attachments (if any)
      onSend({
        role: 'user',
        content: content,
        metadata: {
          useDeepThinker: useDeepThinker
        },
        attachments: attachments.length > 0 ? attachments : undefined
      });
      setContent('');
      setInputFile(null);
      setInputFileExtension('');
      setInputFileContent('');
      setInputFileContentCompressed('');
      setImageRef(null);
      setPdfRef(null);
    }

    else {
      onSend({
        role: 'user',
        content: content,
        metadata: {
          useDeepThinker: useDeepThinker
        }
      });
      setContent('');
      setInputFile(null);
      setInputFileExtension('');
      setInputFileContent('');
      setInputFileContentCompressed('');
      setImageRef(null);
      setPdfRef(null);
    }


    if (window.innerWidth < 640 && textareaRef && textareaRef.current) {
      textareaRef.current.blur();
    }
    
    // Re-enable auto-scroll after sending message so user sees the response
    homeDispatch({ field: 'autoScroll', value: true });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !isTyping && !isMobile() && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === '/' && e.metaKey) {
      e.preventDefault();
    }
  };



  const isMobile = () => {
    if (typeof window === 'undefined') {
      return false;
    }

    return window.matchMedia('(pointer: coarse)').matches;
  };

  const processFile = async ({ fullBase64String, file }: { fullBase64String: string | ArrayBuffer | null, file: File }) => {
    if (!fullBase64String || typeof fullBase64String !== 'string') {
      alert('Invalid file data');
      return;
    }
    const [fileType] = file && file.type.split('/');
    const isPDF = file.type === 'application/pdf';

    if (!isPDF && !["image"].includes(fileType)) {
      alert(`Only supported file types are : images and PDFs`);
      return;
    }

    const maxSize = isPDF ? 10 * 1024 * 1024 : 5 * 1024 * 1024; // 10MB for PDFs, 5MB for images
    if (file && file.size > maxSize) {
      alert(`File size should not exceed : ${isPDF ? '10 MB' : '5 MB'}`);
      return;
    }

    setIsUploadingImage(true);

    try {
      if (isPDF) {
        // Handle PDF upload
        const pdfReference = await uploadPDF(fullBase64String, file.name, file.type);
        setPdfRef(pdfReference);
        setInputFile(file.name);
        setInputFileExtension('pdf');
      } else {
        // Handle image upload
        let imageToUpload = fullBase64String;

        // Check if compression is needed
        const base64WithoutPrefix = imageToUpload.replace(/^data:image\/[a-z]+;base64,/, '');
        const sizeInKB = (base64WithoutPrefix.length * 3 / 4) / 1024;
        const shouldCompress = sizeInKB > 200;

        if (shouldCompress) {
          await new Promise<void>((resolve) => {
            compressImage(imageToUpload, file.type, true, (compressedBase64: string) => {
              imageToUpload = compressedBase64;
              setInputFileContentCompressed(compressedBase64);
              resolve();
            });
          });
        } else {
          setInputFileContentCompressed(imageToUpload);
        }

        // Upload image to Redis and get reference
        const imgRef = await uploadImage(imageToUpload, file.type);
        setImageRef(imgRef);
        setInputFile(file.name);
        const extension = file.name.split('.').pop() ?? 'jpg';
        setInputFileExtension(extension.toLowerCase());
      }

      // Clear the base64 content to save memory
      setInputFileContent('');
    } catch (error) {
      console.error('Error processing image:', error);
      alert('Failed to upload image. Please try again.');
      handleInputFileDelete();
    } finally {
      setIsUploadingImage(false);
    }
  }



  const parseVariables = (content: string) => {
    const regex = /{{(.*?)}}/g;
    const foundVariables = [];
    let match;

    while ((match = regex.exec(content)) !== null) {
      foundVariables.push(match[1]);
    }

    return foundVariables;
  };


  // Additional handlers for drag and drop
  const handleDragOver = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault(); // Necessary to allow the drop event
  };

  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      const reader = new FileReader();
      reader.onload = (loadEvent) => {
        const fullBase64String = (loadEvent.target?.result ?? null) as string | ArrayBuffer | null;
        processFile({ fullBase64String, file });
      };
      reader.readAsDataURL(file);

    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardData = event.clipboardData;
    let items = clipboardData.items;
    let isImagePasted = false;

    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.indexOf("image") === 0) {
          isImagePasted = true;
          const file = item.getAsFile();
          if (file) {
            // Reading the image as Data URL (base64)
            const reader = new FileReader();
            reader.onload = (loadEvent) => {
              const fullBase64String = (loadEvent.target?.result ?? null) as string | ArrayBuffer | null;
              processFile({ fullBase64String, file });
            };
            reader.readAsDataURL(file);
          }
          break; // Stop checking after finding image, preventing any text setting
        }
      }
    }

    // Handle text only if no image was pasted
    if (!isImagePasted) {
      let text = clipboardData.getData('text/plain');
      if (text) {
        // setContent(text); // Set text content only if text is pasted
      }
    }
  };

  useEffect(() => {
    if (textareaRef && textareaRef.current) {
      textareaRef.current.style.height = 'inherit';
      textareaRef.current.style.height = `${textareaRef.current?.scrollHeight}px`;
      textareaRef.current.style.overflow = `${textareaRef?.current?.scrollHeight > 400 ? 'auto' : 'hidden'}`;
    }
  }, [content, textareaRef]);

  const handleSpeechToText = useCallback(() => {
    if (!recognitionRef.current) {
      const SpeechRecognition =
        (window as any)?.SpeechRecognition || (window as any)?.webkitSpeechRecognition;

      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.lang = 'en-US';
      recognitionRef.current.interimResults = true;
      recognitionRef.current.continuous = true;

      recognitionRef.current.onresult = (event: any) => {
        let currentTranscript = '';
        for (let i = 0; i < event.results.length; i++) {
          currentTranscript += event.results[i][0].transcript;
        }
        setContent(currentTranscript);
      };

      recognitionRef.current.onend = () => {
        if (isRecording) {
          recognitionRef.current.start();
        }
      };
    }

    if (!isRecording) {
      // Play sound when recording starts
      if (recordingStartSound.current) {
        recordingStartSound.current.play();
      }
      recognitionRef.current.start();
      setIsRecording(true);
    } else {
      recognitionRef.current.stop();
      setIsRecording(false);
    }
  }, [isRecording]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  const handleVoiceRecordingComplete = (audioBlob: Blob, transcript?: string) => {
    // Handle voice recording
    if (transcript) {
      setContent(transcript);
    }
    setShowVoiceRecorder(false);
    // You can also handle the audio blob here if needed
  };

  // Register quick action handlers with parent if requested
  useEffect(() => {
    if (!onQuickActionsRegister) return;
    onQuickActionsRegister({
      onAttachFile: triggerFileUpload,
      onTakePhoto: triggerPhotoUpload,
      onStartVoice: () => setShowVoiceRecorder(true),
      onToggleDeepThought: handleToggleDeepThinker,
    });
  }, [onQuickActionsRegister, triggerFileUpload, triggerPhotoUpload, handleToggleDeepThinker]);

  // Use a ref to maintain stable positioning
  const inputContainerRef = useRef<HTMLDivElement>(null);

  return (
    <>
      {/* Voice Recorder Modal */}
      {showVoiceRecorder && (
        <VoiceRecorder
          onRecordingComplete={handleVoiceRecordingComplete}
          onCancel={() => setShowVoiceRecorder(false)}
        />
      )}

      <div
        ref={inputContainerRef}
        className="w-full"
        data-chat-input
        style={{
          paddingBottom: `env(safe-area-inset-bottom, 0px)`,
          // Prevent iOS keyboard push behavior
          WebkitTransform: 'translateZ(0)',
          transform: 'translateZ(0)',
        }}
      >
        <div className="flex w-full flex-col">
          {/* Input Container */}
          <div className="w-full">
            <div className="relative">
              {/* Main input wrapper with glass effect */}
              <div
                className={`relative flex items-center w-full rounded-2xl apple-glass backdrop-blur-xl border border-white/10 dark:border-white/5 shadow-[0_8px_32px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.24)] ${inputFile && (imageRef || pdfRef || inputFileContentCompressed) ? 'flex-col items-stretch' : ''}`}
              >
                {/* Quick Actions Button - centered with textarea */}
                <div className="absolute left-3 top-1/2 -translate-y-1/2 z-20">
                  <QuickActionsPopup
                  onAttachFile={triggerFileUpload}
                  onTakePhoto={triggerPhotoUpload}
                  onStartVoice={() => setShowVoiceRecorder(true)}
                  onToggleDeepThought={handleToggleDeepThinker}
                    isDeepThoughtEnabled={useDeepThinker}
                  />
                </div>
                <textarea
                  ref={textareaRef}
                  className="m-0 w-full resize-none bg-transparent py-4 pr-14 md:pr-20 pl-16 text-[15px] leading-relaxed text-neutral-800 outline-none placeholder:text-neutral-500 focus:outline-none dark:text-white dark:placeholder:text-white/40 transition-colors"
                style={{
                  resize: 'none',
                  bottom: `${textareaRef?.current?.scrollHeight}px`,
                  minHeight: '54px',
                  maxHeight: '320px',
                  overflow: `${textareaRef.current && textareaRef.current.scrollHeight > 400 ? 'auto' : 'hidden'}`,
                  // iOS-specific fixes
                  WebkitAppearance: 'none',
                  WebkitTransform: 'translateZ(0)',
                  fontSize: '16px', // Prevents iOS zoom on focus
                }}
                placeholder={isRecording ? 'Listening…' : (t('Send a message') as unknown as string)}
                value={content}
                rows={1}
                onCompositionStart={() => setIsTyping(true)}
                onCompositionEnd={() => setIsTyping(false)}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onFocus={(e) => {
                  // Mobile keyboard handling for all devices
                  if (isMobile()) {
                    // IMPORTANT: Disable chat auto-scroll to prevent it from fighting with input scroll
                    homeDispatch({ field: 'autoScroll', value: false });
                    
                    // In PWA standalone mode, visualViewport handles keyboard positioning
                    // Don't use scrollIntoView as it conflicts with the viewport adjustments
                    const isPWA = window.matchMedia('(display-mode: standalone)').matches || 
                                  (window.navigator as any).standalone === true;
                    
                    if (isPWA) {
                      // In PWA mode, rely on visualViewport adjustments instead of scrollIntoView
                      return;
                    }
                    
                    // Use multiple techniques for best compatibility (browser mode only)
                    
                    // Technique 1: ScrollIntoView (most reliable)
                    setTimeout(() => {
                      e.target.scrollIntoView({ 
                        behavior: 'smooth', 
                        block: 'center',
                        inline: 'nearest'
                      });
                    }, 300); // Wait for keyboard animation

                    // Technique 2: Visual Viewport API (for modern browsers)
                    if (window.visualViewport) {
                      const handleResize = () => {
                        const inputRect = e.target.getBoundingClientRect();
                        const viewportHeight = window.visualViewport!.height;
                        
                        // If input is covered by keyboard, scroll it into view
                        if (inputRect.bottom > viewportHeight - 20) {
                          e.target.scrollIntoView({ 
                            behavior: 'smooth', 
                            block: 'center'
                          });
                        }
                      };
                      
                      // Listen for viewport resize (keyboard appearing)
                      window.visualViewport.addEventListener('resize', handleResize);
                      
                      // Clean up listener after keyboard is shown
                      setTimeout(() => {
                        window.visualViewport?.removeEventListener('resize', handleResize);
                      }, 1000);
                    }
                  }
                }}
                {...(appConfig?.fileUploadEnabled && {
                  onDragOver: handleDragOver,
                  onDrop: handleDrop,
                    onPaste: handlePaste,
                  })}
                />
                {/* Send/Stop Button - centered with textarea */}
                <button
                  className={`absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-2.5 text-white shadow-lg transition-colors duration-150 ${
                    messageIsStreaming
                      ? 'bg-red-500 hover:bg-red-600 dark:bg-red-500 dark:hover:bg-red-600'
                      : 'bg-neutral-900/90 hover:bg-neutral-800 dark:bg-nvidia-green dark:hover:bg-nvidia-green/90'
                  }`}
                  onClick={messageIsStreaming ? handleStop : handleSend}
                  title={messageIsStreaming ? 'Stop generating' : 'Send message'}
                >
                  {messageIsStreaming ? (
                    <IconPlayerStopFilled size={18} />
                  ) : (
                    <IconSend size={18} />
                  )}
                </button>
              </div>
              {inputFile && (imageRef || pdfRef || inputFileContentCompressed) && (
                <div className="w-full border-t border-white/10 dark:border-white/5 mt-2">
                  <div className="flex w-full flex-col gap-3 p-3 text-neutral-800 dark:text-white">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-neutral-600 dark:bg-white/10 dark:text-neutral-100">
                          {pdfRef ? <IconPaperclip size={16} /> : <IconPhoto size={16} />}
                        </span>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-50">{inputFile}</span>
                          {isUploadingImage && <span className="text-xs text-neutral-500">Uploading…</span>}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="rounded-full p-2 text-neutral-400 transition-colors duration-150 hover:bg-white/20 hover:text-red-500 dark:hover:bg-white/10"
                        onClick={handleInputFileDelete}
                        aria-label="Remove attachment"
                      >
                        <IconTrash size={16} />
                      </button>
                    </div>

                    {imageRef && (
                      <div className="mx-auto w-full max-w-[240px] overflow-hidden rounded-xl">
                        <OptimizedImage imageRef={imageRef} alt={inputFile} className="rounded-xl" />
                      </div>
                    )}

                    {pdfRef && (
                      <div className="px-3 py-2 text-center text-xs text-neutral-600 dark:text-neutral-200">
                        PDF ready to process
                      </div>
                    )}
                  </div>
                </div>
              )}
              {
                appConfig?.fileUploadEnabled && !inputFile &&
                <>
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept=".pdf,application/pdf"
                    style={{ display: 'none' }}
                    onChange={handleFileChange}
                  />
                  <input
                    type="file"
                    ref={photoInputRef}
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={handleFileChange}
                  />
                </>
              }
            </div>

          </div>
        </div>
      </div>
    </>
  );
};
