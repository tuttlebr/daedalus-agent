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
  useId,
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
// import { VoiceRecorder } from './VoiceRecorder'; // COMMENTED OUT - Voice recording disabled
import { QuickActions } from './QuickActions';
import { QuickActionsPopup } from './QuickActionsPopup';
import { CollectionSelector } from './CollectionSelector';
import { useAuth } from '@/components/Auth/AuthProvider';
import { GlassPanel } from '@/components/UI/GlassPanel';


interface Props {
  onSend: (message: Message) => void;
  onRegenerate: () => void;
  onScrollDownClick: () => void;
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  showScrollDownButton: boolean;
  controller: MutableRefObject<AbortController>;
  onStop?: () => void;
  onQuickActionsRegister?: (handlers: {
    onAttachFile: () => void;
    onTakePhoto: () => void;
    onToggleDeepThought: () => void;
  }) => void;
}

export const ChatInput: React.FC<Props> = ({
  onSend,
  onScrollDownClick,
  textareaRef,
  showScrollDownButton,
  controller,
  onStop,
  onQuickActionsRegister,
}) => {
  const { t } = useTranslation('chat');
  const { user } = useAuth();

  const {
    state: { selectedConversation, messageIsStreaming, enableIntermediateSteps, conversations, useDeepThinker },
    dispatch: homeDispatch,
  } = useContext(HomeContext);

  // COMMENTED OUT - Audio file loading disabled
  // const recordingStartSound = useRef<HTMLAudioElement | null>(null);

  // useEffect(() => {
  //   if (typeof window !== 'undefined') {
  //     recordingStartSound.current = new Audio('audio/recording.wav');
  //   }
  // }, []);

  const [content, setContent] = useState<string>('');
  const [isTyping, setIsTyping] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [inputFile, setInputFile] = useState<string | null>(null);
  const [inputFileExtension, setInputFileExtension] = useState('');
  const [inputFileContent, setInputFileContent] = useState('');
  const [inputFileContentCompressed, setInputFileContentCompressed] = useState('');
  const [imageRef, setImageRef] = useState<ImageReference | null>(null);
  const [pdfRefs, setPdfRefs] = useState<Array<{ pdfId: string; sessionId: string; filename?: string }>>([])
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  // const [isRecording, setIsRecording] = useState(false); // COMMENTED OUT - Voice recording disabled
  // const [showVoiceRecorder, setShowVoiceRecorder] = useState(false); // COMMENTED OUT - Voice recording disabled
  const [selectedCollection, setSelectedCollection] = useState<string>('');
  // const recognitionRef = useRef<any>(null); // COMMENTED OUT - Voice recording disabled
  const composerStatusId = useId();
  const composerTextareaId = `${composerStatusId}-textarea`;

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
    setPdfRefs([]);
    setSelectedCollection('');
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
    const files = e.target.files;

    if (files && files.length > 0) {
      // Check if all files are PDFs or all are images (don't mix)
      const fileArray = Array.from(files);
      const fileTypes = fileArray.map((f: File) => {
        const isPDF = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
        return isPDF ? 'pdf' : 'image';
      });
      const allPDFs = fileTypes.every(type => type === 'pdf');
      const allImages = fileTypes.every(type => type === 'image');

      if (!allPDFs && !allImages) {
        alert('Please select either PDFs or images, but not both.');
        e.target.value = ''; // Reset after error
        return;
      }

      if (allPDFs) {
        // Check if too many PDFs are selected
        const MAX_PDFS_PER_BATCH = 20;
        if (fileArray.length > MAX_PDFS_PER_BATCH) {
          alert(`Too many PDFs selected (${fileArray.length}). Please select no more than ${MAX_PDFS_PER_BATCH} PDFs at a time to avoid processing timeouts.`);
          e.target.value = ''; // Reset after error
          return;
        }
        // Process multiple PDFs
        processMultipleFiles(fileArray);
      } else {
        // For images, still process single file (existing behavior)
        const file = files[0];
        const reader = new FileReader();
        reader.onload = (loadEvent) => {
          const fullBase64String = (loadEvent.target?.result ?? null) as string | ArrayBuffer | null;
          processFile({ fullBase64String, file });
        };
        reader.readAsDataURL(file);
      }

      // Reset the input value after processing so the same file can be selected again if needed
      e.target.value = '';
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;

    setContent(value);
  };

  const processMultipleFiles = async (files: File[]) => {
    const newPdfRefs: Array<{ pdfId: string; sessionId: string; filename?: string }> = [];
    setIsUploadingImage(true);

    try {
      // Upload all PDFs
      for (const file of files) {
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          const reader = new FileReader();
          const base64String = await new Promise<string>((resolve, reject) => {
            reader.onload = (e: ProgressEvent<FileReader>) => {
              const result = e.target?.result;
              if (typeof result === 'string') {
                resolve(result);
              } else {
                reject(new Error('Failed to read file'));
              }
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });

          const pdfReference = await uploadPDF(base64String, file.name, file.type);
          newPdfRefs.push({ ...pdfReference, filename: file.name });
        }
      }

      if (newPdfRefs.length > 0) {
        setPdfRefs(newPdfRefs);
        setInputFile(newPdfRefs.length === 1 ? newPdfRefs[0].filename || 'document.pdf' : `${newPdfRefs.length} PDFs selected`);
        setInputFileExtension('pdf');
      }
    } catch (error) {
      console.error('Error uploading PDFs:', error);
      alert('Failed to upload PDFs. Please try again.');
      handleInputFileDelete();
    } finally {
      setIsUploadingImage(false);
    }
  };

  const processPDFInBackground = async (pdfRefsData: Array<{ pdfId: string; sessionId: string; filename?: string }>, filenameDisplay: string) => {
    try {
      const response = await fetch('/api/pdf/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pdfRefs: pdfRefsData,
          filename: filenameDisplay,
          collection: selectedCollection || user?.username || 'default'
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        console.error('Failed to process PDF:', result);
        toast.error('Failed to process PDF. Please try again.');
        return false;
      }

      console.log('PDFs processed successfully:', result);
      const collectionUsed = result.metadata?.collection || selectedCollection || user?.username || 'default';
      const pdfCount = pdfRefsData.length;
      const successMsg = pdfCount === 1
        ? `PDF uploaded to collection "${collectionUsed}"`
        : `${pdfCount} PDFs uploaded to collection "${collectionUsed}"`;
      toast.success(successMsg);

      // Add an assistant message to the conversation to provide context
      if (selectedConversation) {
        const contentMessage = pdfCount === 1
          ? `Your PDF was uploaded successfully to the "${collectionUsed}" collection. The document has been processed and indexed for future search and retrieval.`
          : `Your ${pdfCount} PDFs were uploaded successfully to the "${collectionUsed}" collection. All documents have been processed and indexed for future search and retrieval.`;

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
    // Call the parent's stop handler if provided (handles both streaming and async modes)
    if (onStop) {
      onStop();
    } else {
      // Fallback to direct controller abort for streaming mode
      if (controller.current) {
        controller.current.abort();
        controller.current = new AbortController();
        // Reset streaming state immediately for better UX
        homeDispatch({ field: 'messageIsStreaming', value: false });
        homeDispatch({ field: 'loading', value: false });
      }
    }
  };

  const handleSend = async () => {
    if (messageIsStreaming || isUploadingImage) {
      return;
    }

    // COMMENTED OUT - Voice recognition disabled
    // if (isRecording && recognitionRef.current) {
    //   recognitionRef.current.stop();
    //   setIsRecording(false);
    // }

    if (!content && !inputFile && !imageRef && pdfRefs.length === 0) {
      alert(t('Please enter a message or attach a file'));
      return;
    }

    // Process PDFs first if there are any
    if (pdfRefs.length > 0) {
      // Show processing message
      const toastMsg = pdfRefs.length === 1 ? 'Processing PDF...' : `Processing ${pdfRefs.length} PDFs...`;
      toast.loading(toastMsg, { id: 'pdf-processing' });

      const success = await processPDFInBackground(pdfRefs, inputFile || 'documents');

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
        setPdfRefs([]);
        setSelectedCollection('');
        if (window.innerWidth < 640 && textareaRef && textareaRef.current) {
          textareaRef.current.blur();
        }
        return;
      }
    }

    // Store deep thinker mode in metadata instead of appending to content
    if (inputFile || imageRef || pdfRefs.length > 0) {
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
      setPdfRefs([]);
      setSelectedCollection('');
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
      setPdfRefs([]);
      setSelectedCollection('');
    }


    if (window.innerWidth < 640 && textareaRef && textareaRef.current) {
      textareaRef.current.blur();
    }

    // Re-enable auto-scroll after sending message so user sees the response
    homeDispatch({ field: 'autoScroll', value: true });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter to send (desktop), Shift+Enter for new line
    if (e.key === 'Enter' && !isTyping && !isMobile() && !e.shiftKey) {
      e.preventDefault();
      if (content.trim() || inputFile || imageRef || pdfRefs.length > 0) {
        handleSend();
      }
    } 
    // Escape to clear or cancel
    else if (e.key === 'Escape') {
      if (inputFile || imageRef || pdfRefs.length > 0) {
        handleInputFileDelete();
      } else if (content) {
        setContent('');
      }
    }
    // Command/Ctrl + / for shortcuts (prevent default)
    else if (e.key === '/' && (e.metaKey || e.ctrlKey)) {
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
    const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

    if (!isPDF && !["image"].includes(fileType)) {
      alert(`Only supported file types are : images and PDFs`);
      return;
    }

    const maxSize = isPDF ? 20 * 1024 * 1024 : 5 * 1024 * 1024; // 20MB for PDFs, 5MB for images
    if (file && file.size > maxSize) {
      alert(`File size should not exceed : ${isPDF ? '20 MB' : '5 MB'}`);
      return;
    }

    setIsUploadingImage(true);

    try {
      if (isPDF) {
        // Handle PDF upload
        const pdfReference = await uploadPDF(fullBase64String, file.name, file.type);
        setPdfRefs([{ ...pdfReference, filename: file.name }]);
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
      // Check if all files are PDFs or all are images (don't mix)
      const fileTypes = Array.from(files).map((f: File) => f.type.startsWith('image/') ? 'image' : 'pdf');
      const allPDFs = fileTypes.every(type => type === 'pdf');
      const allImages = fileTypes.every(type => type === 'image');

      if (!allPDFs && !allImages) {
        alert('Please select either PDFs or images, but not both.');
        return;
      }

      if (allPDFs && files.length > 1) {
        // Check if too many PDFs are selected
        const MAX_PDFS_PER_BATCH = 20;
        if (files.length > MAX_PDFS_PER_BATCH) {
          alert(`Too many PDFs selected (${files.length}). Please select no more than ${MAX_PDFS_PER_BATCH} PDFs at a time to avoid processing timeouts.`);
          return;
        }
        // Process multiple PDFs
        processMultipleFiles(Array.from(files));
      } else {
        // For single file or images, use existing logic
        const file = files[0];
        const reader = new FileReader();
        reader.onload = (loadEvent) => {
          const fullBase64String = (loadEvent.target?.result ?? null) as string | ArrayBuffer | null;
          processFile({ fullBase64String, file });
        };
        reader.readAsDataURL(file);
      }
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

  // Auto-grow textarea with smooth transitions
  useEffect(() => {
    if (textareaRef && textareaRef.current) {
      // Reset height to get accurate scrollHeight
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      const minHeight = 54; // min-h-[54px]
      const maxHeight = 320; // max-h-[320px]
      
      // Set height within bounds
      const newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
      textareaRef.current.style.height = `${newHeight}px`;
      
      // Enable scrolling if content exceeds max height
      textareaRef.current.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
    }
  }, [content, textareaRef]);

  // COMMENTED OUT - Speech-to-text functionality disabled
  // const handleSpeechToText = useCallback(() => {
  //   if (!recognitionRef.current) {
  //     const SpeechRecognition =
  //       (window as any)?.SpeechRecognition || (window as any)?.webkitSpeechRecognition;

  //     recognitionRef.current = new SpeechRecognition();
  //     recognitionRef.current.lang = 'en-US';
  //     recognitionRef.current.interimResults = true;
  //     recognitionRef.current.continuous = true;

  //     recognitionRef.current.onresult = (event: any) => {
  //       let currentTranscript = '';
  //       for (let i = 0; i < event.results.length; i++) {
  //         currentTranscript += event.results[i][0].transcript;
  //       }
  //       setContent(currentTranscript);
  //     };

  //     recognitionRef.current.onend = () => {
  //       if (isRecording) {
  //         recognitionRef.current.start();
  //       }
  //     };
  //   }

  //   if (!isRecording) {
  //     // Play sound when recording starts
  //     if (recordingStartSound.current) {
  //       recordingStartSound.current.play();
  //     }
  //     recognitionRef.current.start();
  //     setIsRecording(true);
  //   } else {
  //     recognitionRef.current.stop();
  //     setIsRecording(false);
  //   }
  // }, [isRecording]);

  // useEffect(() => {
  //   return () => {
  //     if (recognitionRef.current) {
  //       recognitionRef.current.stop();
  //     }
  //   };
  // }, []);

  // const handleVoiceRecordingComplete = (audioBlob: Blob, transcript?: string) => {
  //   // Handle voice recording
  //   if (transcript) {
  //     setContent(transcript);
  //   }
  //   setShowVoiceRecorder(false);
  //   // You can also handle the audio blob here if needed
  // };

  // Register quick action handlers with parent if requested
  useEffect(() => {
    if (!onQuickActionsRegister) return;
    onQuickActionsRegister({
      onAttachFile: triggerFileUpload,
      onTakePhoto: triggerPhotoUpload,
      onToggleDeepThought: handleToggleDeepThinker,
    });
  }, [onQuickActionsRegister, triggerFileUpload, triggerPhotoUpload, handleToggleDeepThinker]);

  // Use a ref to maintain stable positioning
  const inputContainerRef = useRef<HTMLDivElement>(null);

  const canSend = Boolean(content.trim()) || Boolean(inputFile) || Boolean(imageRef) || pdfRefs.length > 0;
  const sendButtonDisabled = !messageIsStreaming && !canSend;

  return (
    <>
      {/* Voice Recorder Modal - COMMENTED OUT - Voice recording disabled */}
      {/* {showVoiceRecorder && (
        <VoiceRecorder
          onRecordingComplete={handleVoiceRecordingComplete}
          onCancel={() => setShowVoiceRecorder(false)}
        />
      )} */}

      <div
        ref={inputContainerRef}
        className="w-full"
        data-chat-input
        style={{
          paddingBottom: `env(safe-area-inset-bottom, 0px)`,
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          overflowX: 'hidden',
          overflowY: 'visible',
          // Prevent iOS keyboard push behavior
          WebkitTransform: 'translateZ(0)',
          transform: 'translateZ(0)',
        }}
      >
        <div className="flex w-full flex-col" style={{ width: '100%', maxWidth: '100%', minWidth: 0 }}>
          {/* Input Container - 8-12px padding (Apple design) */}
          <div className="w-full px-2 sm:px-3" style={{ width: '100%', maxWidth: '100%', minWidth: 0, paddingTop: '12px', paddingBottom: '12px', overflow: 'visible' }}>
            <div className="relative" style={{ width: '100%', maxWidth: '100%', minWidth: 0, overflow: 'visible' }}>
              <GlassPanel
                depth={useDeepThinker ? 'floating' : 'raised'}
                glow={useDeepThinker ? 'accent' : 'soft'}
                className="flex w-full flex-col gap-3 rounded-[28px] px-3 py-3 sm:px-5 sm:py-4"
                aria-live="polite"
                aria-busy={isUploadingImage}
              >
                {/* Quick Actions Button - centered with textarea */}
                <div className="absolute left-3 top-1/2 z-20 -translate-y-1/2 sm:left-4" style={{ overflow: 'visible' }}>
                  <QuickActionsPopup
                    onAttachFile={triggerFileUpload}
                    onTakePhoto={triggerPhotoUpload}
                    onToggleDeepThought={handleToggleDeepThinker}
                    isDeepThoughtEnabled={useDeepThinker}
                  />
                </div>
                <textarea
                  ref={textareaRef}
                  id={composerTextareaId}
                  className="m-0 w-full resize-none bg-transparent py-4 pr-16 pl-14 text-[clamp(1rem,0.95rem+0.2vw,1.1rem)] leading-relaxed text-white placeholder:text-white/40 outline-none transition-colors sm:pl-[4.5rem]"
                  role="textbox"
                  aria-label="Message input"
                  aria-multiline="true"
                  aria-required="false"
                  aria-describedby={composerStatusId}
                  style={{
                    resize: 'none',
                    bottom: `${textareaRef?.current?.scrollHeight}px`,
                    minHeight: '54px',
                    maxHeight: '320px',
                    width: '100%',
                    maxWidth: '100%',
                    minWidth: 0,
                    overflow: `${textareaRef.current && textareaRef.current.scrollHeight > 400 ? 'auto' : 'hidden'}`,
                    overflowX: 'hidden',
                    WebkitAppearance: 'none',
                    WebkitTransform: 'translateZ(0)',
                    lineHeight: 1.5,
                  }}
                  placeholder={t('Send a message') as unknown as string}
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

                    // Use Visual Viewport API for modern browsers (browser mode only)
                    // This keeps the input visible without jumping to the top
                    if (window.visualViewport) {
                      const handleResize = () => {
                        const inputRect = e.target.getBoundingClientRect();
                        const viewportHeight = window.visualViewport!.height;

                        // If input is covered by keyboard, scroll it into view at the bottom
                        // Use 'end' instead of 'center' to prevent jumping to top
                        if (inputRect.bottom > viewportHeight - 20) {
                          e.target.scrollIntoView({
                            behavior: 'smooth',
                            block: 'end',
                            inline: 'nearest'
                          });
                        }
                      };

                      // Listen for viewport resize (keyboard appearing)
                      window.visualViewport.addEventListener('resize', handleResize);

                      // Clean up listener after keyboard is shown
                      setTimeout(() => {
                        window.visualViewport?.removeEventListener('resize', handleResize);
                      }, 1000);
                    } else {
                      // Fallback for browsers without visualViewport API
                      // Use 'end' to keep input at bottom instead of jumping to center/top
                      setTimeout(() => {
                        e.target.scrollIntoView({
                          behavior: 'smooth',
                          block: 'end',
                          inline: 'nearest'
                        });
                      }, 300); // Wait for keyboard animation
                    }
                  }
                }}
                {...(appConfig?.fileUploadEnabled && {
                  onDragOver: handleDragOver,
                  onDrop: handleDrop,
                    onPaste: handlePaste,
                  })}
                />
                <button
                  type="button"
                  className={`absolute right-3 top-1/2 flex min-h-[44px] min-w-[44px] -translate-y-1/2 items-center justify-center rounded-full text-white transition-all duration-200 sm:right-4 ${
                    messageIsStreaming
                      ? 'bg-gradient-to-r from-rose-500 via-orange-400 to-rose-500 text-white shadow-[0_0_30px_rgba(255,95,109,0.4)] animate-pulse'
                      : sendButtonDisabled
                      ? 'cursor-not-allowed bg-white/20 text-white/60'
                      : 'bg-gradient-to-r from-cyan-300 via-sky-300 to-emerald-300 text-[#03121f] shadow-[0_0_35px_rgba(78,243,255,0.35)] hover:shadow-[0_0_40px_rgba(78,243,255,0.5)]'
                  }`}
                  onClick={(e) => {
                    // Disable send if no content
                    if (!messageIsStreaming && sendButtonDisabled) {
                      return;
                    }
                    // Haptic feedback (if supported)
                    if ('vibrate' in navigator) {
                      navigator.vibrate(10);
                    }
                    // Scale animation on click
                    e.currentTarget.style.transform = 'scale(0.9)';
                    setTimeout(() => {
                      e.currentTarget.style.transform = '';
                    }, 150);
                    if (messageIsStreaming) {
                      handleStop();
                    } else {
                      handleSend();
                    }
                  }}
                  disabled={sendButtonDisabled}
                  aria-disabled={sendButtonDisabled}
                  aria-busy={messageIsStreaming || isUploadingImage}
                  title={messageIsStreaming ? 'Stop generating' : sendButtonDisabled ? 'Enter a message to send' : 'Send message'}
                  aria-label={messageIsStreaming ? 'Stop generating' : sendButtonDisabled ? 'Enter a message to send' : 'Send message'}
                  aria-controls={composerTextareaId}
                >
                  {messageIsStreaming ? (
                    <IconPlayerStopFilled size={18} className="animate-pulse" />
                  ) : (
                    <IconSend size={18} />
                  )}
                </button>
                <span id={composerStatusId} className="sr-only" aria-live="polite">
                  {messageIsStreaming
                    ? 'Assistant is responding. Press the button to stop.'
                    : sendButtonDisabled
                      ? 'Type a message or attach a file to enable the send button.'
                      : 'Send button ready.'}
                </span>
                {inputFile && (imageRef || pdfRefs.length > 0 || inputFileContentCompressed) && (
                  <div className="w-full border-t border-white/15 pt-3">
                    <div className="flex w-full flex-col gap-3 text-white">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 text-white">
                          {pdfRefs.length > 0 ? <IconPaperclip size={16} /> : <IconPhoto size={16} />}
                        </span>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-white">{inputFile}</span>
                          {isUploadingImage && (
                            <span className="text-xs text-white/70" aria-live="polite">
                              Uploading…
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-white/70 transition-all duration-200 hover:bg-white/15 hover:text-red-400 active:scale-95"
                        onClick={(e) => {
                          // Haptic feedback (if supported)
                          if ('vibrate' in navigator) {
                            navigator.vibrate(10);
                          }
                          handleInputFileDelete();
                        }}
                        aria-label="Remove attachment"
                      >
                        <IconTrash size={16} />
                      </button>
                    </div>

                    {imageRef && (
                      <div className="mx-auto w-full max-w-[240px] overflow-hidden rounded-2xl border border-white/10">
                        <OptimizedImage imageRef={imageRef} alt={inputFile} className="rounded-2xl" />
                      </div>
                    )}

                    {pdfRefs.length > 0 && (
                      <>
                        <div className="px-3 py-2 space-y-1">
                          <div className="text-center text-xs text-white/80">
                            {pdfRefs.length === 1 ? 'PDF ready to process' : `${pdfRefs.length} PDFs ready to process`}
                          </div>
                          <div className="text-center text-xs text-white/60">
                            Choose where to store {pdfRefs.length === 1 ? 'this document' : 'these documents'} for future search
                          </div>
                        </div>
                        {pdfRefs.length > 1 && (
                          <div className="px-3 py-1">
                            <div className="text-xs text-white/80">
                              <div className="font-medium mb-1">Files selected:</div>
                              <ul className="max-h-24 overflow-y-auto space-y-0.5">
                                {pdfRefs.map((pdf: { pdfId: string; sessionId: string; filename?: string }, idx: number) => (
                                  <li key={idx} className="truncate">• {pdf.filename || `PDF ${idx + 1}`}</li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        )}
                        <div className="px-3 pb-3" style={{ position: 'relative', zIndex: 10 }}>
                          <CollectionSelector
                            onSelect={setSelectedCollection}
                            selectedCollection={selectedCollection}
                            defaultCollection={user?.username || 'default'}
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}
              </GlassPanel>
              {
                appConfig?.fileUploadEnabled &&
                <>
                  <input
                    key="pdf-file-input"
                    type="file"
                    ref={fileInputRef}
                    accept="application/pdf,.pdf"
                    multiple={true}
                    style={{ display: 'none' }}
                    onChange={handleFileChange}
                  />
                  <input
                    key="photo-file-input"
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
