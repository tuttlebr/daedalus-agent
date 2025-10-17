import {
  IconArrowDown,
  IconMicrophone,
  IconPaperclip,
  IconPhoto,
  IconCamera,
  IconPlayerStop,
  IconPlayerStopFilled,
  IconRepeat,
  IconSend,
  IconTrash,
  IconBrain,
} from '@tabler/icons-react';
import {
  KeyboardEvent,
  MutableRefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

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
import { useAuth } from '@/components/Auth/AuthProvider';
import { VoiceRecorder } from './VoiceRecorder';
import { QuickActions } from './QuickActions';

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
    onSelectPrompt: (prompt: string) => void;
  }) => void;
}

export const ChatInputNew = ({
  onSend,
  onRegenerate,
  onScrollDownClick,
  textareaRef,
  showScrollDownButton,
  controller,
  onQuickActionsRegister,
}: Props) => {
  const { t } = useTranslation('chat');
  const { user } = useAuth();

  const {
    state: { selectedConversation, messageIsStreaming, loading, enableIntermediateSteps, conversations, showChatbar, useDeepThinker, showVoiceRecorder },
    dispatch: homeDispatch,
    quickActionHandlers,
  } = useContext(HomeContext);

  const [isDesktop, setIsDesktop] = useState(false);

  const [content, setContent] = useState<string>('');
  const [isTyping, setIsTyping] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [inputFile, setInputFile] = useState<string | null>(null);
  const [imageRef, setImageRef] = useState<ImageReference | null>(null);
  const [pdfRef, setPdfRef] = useState<PDFReference | null>(null);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  // Moved to context - const [useDeepThinker, setUseDeepThinker] = useState(false);
  // Moved to context - const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  // Register quick action handlers with parent context
  useEffect(() => {
    if (onQuickActionsRegister) {
      onQuickActionsRegister({
        onAttachFile: triggerFileUpload,
        onTakePhoto: triggerPhotoUpload,
        onStartVoice: () => homeDispatch({ field: 'showVoiceRecorder', value: true }),
        onSelectPrompt: handleSelectPrompt,
      });
    }
  }, [onQuickActionsRegister, homeDispatch]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 768px)');
    const update = (event: MediaQueryListEvent | MediaQueryList) => {
      setIsDesktop('matches' in event ? event.matches : (event as MediaQueryList).matches);
    };

    update(mq);
    const listener = (event: MediaQueryListEvent) => update(event);
    if (mq.addEventListener) {
      mq.addEventListener('change', listener);
    } else {
      mq.addListener(listener);
    }
    return () => {
      if (mq.removeEventListener) {
        mq.removeEventListener('change', listener);
      } else {
        mq.removeListener(listener);
      }
    };
  }, []);

  const desktopOffset = isDesktop ? (showChatbar ? 260 : 0) : 0;

  // Focus management
  useEffect(() => {
    if (!showVoiceRecorder && !isUploadingFile && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [showVoiceRecorder, isUploadingFile]);

  // Auto-expand input when content changes
  useEffect(() => {
    if (textareaRef.current) {
      // Reset height to min-height first to get accurate scrollHeight
      textareaRef.current.style.height = '56px';
      const scrollHeight = textareaRef.current.scrollHeight;
      if (scrollHeight > 56) {
        textareaRef.current.style.height = `${scrollHeight}px`;
        textareaRef.current.style.overflowY = 'hidden';
      }
      setIsExpanded(scrollHeight > 60);
    }
  }, [content]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !isTyping && !isMobile() && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isMobile = () => {
    return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  };

  const handleSend = async () => {
    if (messageIsStreaming || isUploadingFile) return;
    if (!content.trim() && !inputFile) {
      toast.error('Please enter a message or attach a file');
      return;
    }

    // Process PDFs in background
    if (pdfRef) {
      toast.loading('Processing PDF...', { id: 'pdf-processing' });
      await processPDFInBackground(pdfRef, inputFile || 'document.pdf');
      toast.dismiss('pdf-processing');
    }

    const message: Message = {
      role: 'user',
      content: content || (pdfRef ? `Processing PDF: ${inputFile}` : ''),
      metadata: { useDeepThinker },
      attachments: imageRef ? [{
        content: '',
        type: 'image',
        imageRef: imageRef
      }] : undefined
    };

    onSend(message);
    resetInput();
  };

  const resetInput = () => {
    setContent('');
    setInputFile(null);
    setImageRef(null);
    setPdfRef(null);
    homeDispatch({ field: 'useDeepThinker', value: false });
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleStopConversation = () => {
    controller.current?.abort('aborted');
    setTimeout(() => {
      controller.current = new AbortController();
    }, 100);
  };

  const triggerFileUpload = () => {
    fileInputRef.current?.click();
  };

  const triggerPhotoUpload = () => {
    photoInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    e.target.value = '';
    setIsUploadingFile(true);

    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64String = event.target?.result;
        if (typeof base64String !== 'string') return;

        if (file.type === 'application/pdf') {
          const pdfReference = await uploadPDF(base64String, file.name, file.type);
          setPdfRef(pdfReference);
          setInputFile(file.name);
        } else if (file.type.startsWith('image/')) {
          let imageToUpload = base64String;

          // Compress if needed
          const sizeInKB = (base64String.length * 3 / 4) / 1024;
          if (sizeInKB > 200) {
            await new Promise<void>((resolve) => {
              compressImage(base64String, file.type, true, (compressed: string) => {
                imageToUpload = compressed;
                resolve();
              });
            });
          }

          const imgRef = await uploadImage(imageToUpload, file.type);
          setImageRef(imgRef);
          setInputFile(file.name);
        }
      };
      reader.readAsDataURL(file);
    } catch (error) {
      console.error('File upload error:', error);
      toast.error('Failed to upload file');
    } finally {
      setIsUploadingFile(false);
    }
  };

  const handleVoiceRecordingComplete = (audioBlob: Blob, transcript?: string) => {
    if (transcript) {
      setContent(content + (content ? ' ' : '') + transcript);
    }
    homeDispatch({ field: 'showVoiceRecorder', value: false });
  };

  const handleSelectPrompt = (prompt: string) => {
    setContent(content + (content ? ' ' : '') + prompt + ' ');
    textareaRef.current?.focus();
  };

  const processPDFInBackground = async (pdfRef: PDFReference, filename: string) => {
    // PDF processing logic here
    return true;
  };

  return (
    <>
      {showVoiceRecorder && (
        <VoiceRecorder
          onRecordingComplete={handleVoiceRecordingComplete}
          onCancel={() => homeDispatch({ field: 'showVoiceRecorder', value: false })}
        />
      )}

      <div
        className="pointer-events-none fixed bottom-0 right-0 z-40 w-full"
        style={{
          left: desktopOffset,
          paddingBottom: isDesktop
            ? 'max(env(safe-area-inset-bottom), 16px)'
            : 'calc(64px + env(safe-area-inset-bottom))', // BottomNav height + safe area
        }}
      >
        <div className="pointer-events-auto">
          {/* Glass morphism background with improved Apple-style styling */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-transparent" />

          <div className="relative">
            {/* Mobile quick actions - temporarily hidden to prevent overlap
                These actions are now available in the bottom navigation bar */}
            {/* <div className="md:hidden px-4 pb-2">
              <QuickActions
                onAttachFile={triggerFileUpload}
                onTakePhoto={triggerPhotoUpload}
                onStartVoice={() => homeDispatch({ field: 'showVoiceRecorder', value: true })}
                onSelectPrompt={handleSelectPrompt}
                onToggleDeepThought={() => homeDispatch({ field: 'useDeepThinker', value: !useDeepThinker })}
                isDeepThoughtEnabled={useDeepThinker}
                className="apple-glass-subtle rounded-2xl"
              />
            </div> */}

            {/* Input container with Apple glass effect */}
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 sm:px-6 pb-4 pt-2">
              {/* Attached file preview */}
              {inputFile && (
                <div className="apple-glass rounded-2xl p-3 animate-slide-in">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 flex-1">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10">
                        {pdfRef ? <IconPaperclip size={18} className="text-white/80" /> : <IconPhoto size={18} className="text-white/80" />}
                      </div>
                      <span className="text-sm font-medium text-white/90 truncate">{inputFile}</span>
                    </div>
                    <button
                      onClick={() => {
                        setInputFile(null);
                        setImageRef(null);
                        setPdfRef(null);
                      }}
                      className="rounded-lg p-1.5 text-white/60 transition-all hover:bg-white/10 hover:text-white active:scale-95"
                      aria-label="Remove attachment"
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                </div>
              )}

              <div className="apple-glass rounded-3xl shadow-2xl animate-scale-in">
                <div className="flex items-center gap-2 p-3">
                  {/* Desktop action buttons - moved outside and aligned */}
                  <div className="hidden md:flex items-center gap-1">
                    {!messageIsStreaming && (
                      <>
                        <button
                          onClick={triggerFileUpload}
                          className="rounded-lg p-2 text-white/60 transition-all hover:bg-white/10 hover:text-white active:scale-95"
                          disabled={isUploadingFile}
                          title="Attach file"
                        >
                          <IconPaperclip size={20} />
                        </button>
                        <button
                          onClick={triggerPhotoUpload}
                          className="rounded-lg p-2 text-white/60 transition-all hover:bg-white/10 hover:text-white active:scale-95"
                          disabled={isUploadingFile}
                          title="Add photo"
                        >
                          <IconPhoto size={20} />
                        </button>
                      </>
                    )}
                  </div>

                  {/* Textarea container */}
                  <div className="flex-1">
                    <textarea
                      ref={textareaRef}
                      className={`
                        w-full resize-none overflow-hidden bg-transparent px-4 py-3 text-[16px]
                        text-white outline-none transition-all duration-200 placeholder:text-white/40
                        focus:placeholder:text-white/60
                      `}
                      style={{
                        minHeight: '24px',
                        maxHeight: '200px',
                        lineHeight: '1.4',
                      }}
                      placeholder={messageIsStreaming ? 'Reasoning...' : 'Message'}
                      value={content}
                      onChange={handleChange}
                      onKeyDown={handleKeyDown}
                      onCompositionStart={() => setIsTyping(true)}
                      onCompositionEnd={() => setIsTyping(false)}
                      disabled={messageIsStreaming}
                      rows={1}
                    />
                  </div>

                  {/* Send/Stop button */}
                  {messageIsStreaming ? (
                    <button
                      onClick={handleStopConversation}
                      className="rounded-full bg-white/20 p-2.5 text-white shadow-sm backdrop-blur-sm transition-all hover:bg-white/30 active:scale-95"
                      aria-label="Stop generating"
                    >
                      <IconPlayerStopFilled size={20} />
                    </button>
                  ) : (
                    <button
                      onClick={handleSend}
                      disabled={!content.trim() && !inputFile}
                      className={`
                        rounded-full p-2.5 shadow-sm backdrop-blur-sm transition-all active:scale-95
                        ${content.trim() || inputFile
                          ? 'bg-white text-black hover:bg-white/90'
                          : 'bg-white/20 text-white/60 cursor-not-allowed'}
                      `}
                      aria-label="Send message"
                    >
                      <IconSend size={20} />
                    </button>
                  )}
                </div>
              </div>

              {/* Desktop Deep Thinker toggle */}
              <div className="hidden md:flex items-center justify-center mt-2">
                <button
                  onClick={() => homeDispatch({ field: 'useDeepThinker', value: !useDeepThinker })}
                  className={`
                    apple-glass-subtle inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all
                    ${useDeepThinker
                      ? 'text-nvidia-green'
                      : 'text-white/60 hover:text-white/80'}
                  `}
                >
                  <IconBrain size={16} />
                  <span>Deep Thinker</span>
                  <span className={`
                    inline-flex h-2 w-2 rounded-full transition-colors
                    ${useDeepThinker ? 'bg-nvidia-green' : 'bg-white/30'}
                  `} />
                </button>
              </div>
            </div>
          </div>

        {/* File inputs */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={handleFileChange}
        />
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />
        </div>
      </div>
    </>
  );
};
