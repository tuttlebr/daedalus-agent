import {
  IconArrowDown,
  IconMicrophone,
  IconPaperclip,
  IconPhoto,
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
  Ref,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useTranslation } from 'next-i18next';

import { Message } from '@/types/chat';

import HomeContext from '@/pages/api/home/home.context';
import { compressImage } from '@/utils/app/helper';
import { appConfig } from '@/utils/app/const';
import { uploadImage, ImageReference } from '@/utils/app/imageHandler';
import { OptimizedImage } from './OptimizedImage';


interface Props {
  onSend: (message: Message) => void;
  onRegenerate: () => void;
  onScrollDownClick: () => void;
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  showScrollDownButton: boolean;
  controller: Ref<AbortController>
}

export const ChatInput = ({
  onSend,
  onRegenerate,
  onScrollDownClick,
  textareaRef,
  showScrollDownButton,
  controller,
}: Props) => {
  const { t } = useTranslation('chat');

  const {
    state: { selectedConversation, messageIsStreaming, loading },
    dispatch: homeDispatch,
  } = useContext(HomeContext);

  // todo add the audio file
  const recordingStartSound = new Audio('audio/recording.wav');

  const [content, setContent] = useState<string>('');
  const [isTyping, setIsTyping] = useState<boolean>(false);
  const fileInputRef = useRef(null);
  const [inputFile, setInputFile] = useState(null)
  const [inputFileExtension, setInputFileExtension] = useState('')
  const [inputFileContent, setInputFileContent] = useState('')
  const [inputFileContentCompressed, setInputFileContentCompressed] = useState('')
  const [imageRef, setImageRef] = useState<ImageReference | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [useDeepThinker, setUseDeepThinker] = useState(false);
  const recognitionRef = useRef(null);

  const triggerFileUpload = () => {
    fileInputRef?.current.click();
  };

  const handleInputFileDelete = (e: React.ChangeEvent<HTMLTextAreaElement> | null) => {
    setInputFile(null);
    setInputFileExtension('');
    setInputFileContent('');
    setInputFileContentCompressed('');
    setImageRef(null);
  };

  const handleFileChange = (e: { target: { files: any[]; value: null; }; }) => {
    const file = e.target.files[0]
    if (file) {
      // Reset the input value so the same file can be selected again if needed
      e.target.value = null
      const reader = new FileReader()
      reader.onload = (loadEvent) => {
        const fullBase64String = loadEvent.target?.result;
        processFile({ fullBase64String, file })
      };
      reader.readAsDataURL(file)
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;

    setContent(value);
  };

  const handleSend = () => {
    if (messageIsStreaming || isUploadingImage) {
      return;
    }

    // stop recognition if it's running
    if (isRecording) {
      recognitionRef.current.stop();
      setIsRecording(false);
    }

    if (!content && !inputFile && !imageRef) {
      alert(t('Please enter a message or attach an image'));
      return;
    }

    // Store deep thinker mode in metadata instead of appending to content
    if (inputFile || imageRef) {
      onSend({
        role: 'user',
        content: content,
        metadata: {
          useDeepThinker: useDeepThinker
        },
        attachments: [{
          content: '', // Don't send base64 in the message
          type: 'image',
          imageRef: imageRef
        }]
      })
      setContent('');
      setInputFile(null)
      setInputFileExtension('')
      setInputFileContent('')
      setInputFileContentCompressed('');
      setImageRef(null);
    }

    else {
      onSend({
        role: 'user',
        content: content,
        metadata: {
          useDeepThinker: useDeepThinker
        }
      })
      setContent('');
      setInputFile(null)
      setInputFileExtension('')
      setInputFileContent('')
      setInputFileContentCompressed('');
      setImageRef(null);
    }


    if (window.innerWidth < 640 && textareaRef && textareaRef.current) {
      textareaRef.current.blur();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !isTyping && !isMobile() && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === '/' && e.metaKey) {
      e.preventDefault();
    }
  };


  const handleStopConversation = () => {
    try {
      controller?.current?.abort('aborted');
      setTimeout(() => {
        controller.current = new AbortController(); // Reset the controller
      }, 100);
    } catch (error) {
      console.log('error aborting - ', error);
    }
  };

  const isMobile = () => {
    if (typeof window === 'undefined') {
      return false;
    }

    return window.matchMedia('(pointer: coarse)').matches;
  };


  const processFile = async ({ fullBase64String, file }: { fullBase64String: string, file: File }) => {
    const [fileType] = file && file.type.split('/');
    if (!["image"].includes(fileType)) {
      alert(`Only supported file types are : ${["image"].join(', ')}`);
      return;
    }

    if (file && file.size > 5 * 1024 * 1024) {
      alert(`File size should not exceed : 5 MB`);
      return;
    }

    const base64WithoutPrefix = fullBase64String.replace(/^data:image\/[a-z]+;base64,/, '');
    const sizeInKB = (base64WithoutPrefix.length * 3 / 4) / 1024;
    // Compress image only if it larger than 200KB
    const shouldCompress = sizeInKB > 200;

    setIsUploadingImage(true);

    try {
      let imageToUpload = fullBase64String;

      if (shouldCompress) {
        await new Promise<void>((resolve) => {
          compressImage(fullBase64String, file.type, true, (compressedBase64: string) => {
            imageToUpload = compressedBase64;
            setInputFileContentCompressed(compressedBase64);
            resolve();
          });
        });
      } else {
        setInputFileContentCompressed(fullBase64String);
      }

      // Upload image to Redis and get reference
      const imgRef = await uploadImage(imageToUpload, file.type);
      setImageRef(imgRef);
      setInputFile(file.name);
      const extension = file.name.split('.').pop() ?? 'jpg';
      setInputFileExtension(extension.toLowerCase());

      // Clear the base64 content to save memory
      setInputFileContent('');
    } catch (error) {
      console.error('Error processing image:', error);
      alert('Failed to upload image. Please try again.');
      handleInputFileDelete(null);
    } finally {
      setIsUploadingImage(false);
    }
  }


  const handleInitModal = () => {
    const selectedPrompt = filteredPrompts[activePromptIndex];
    if (selectedPrompt) {
      setContent((prevContent) => {
        const newContent = prevContent?.replace(
          /\/\w*$/,
          selectedPrompt.content,
        );
        return newContent;
      });
      handlePromptSelect(selectedPrompt);
    }
    setShowPromptList(false);
  };

  const parseVariables = (content: string) => {
    const regex = /{{(.*?)}}/g;
    const foundVariables = [];
    let match;

    while ((match = regex.exec(content)) !== null) {
      foundVariables.push(match[1]);
    }

    return foundVariables;
  };

  const handleSubmit = (updatedVariables: string[]) => {
    const newContent = content?.replace(/{{(.*?)}}/g, (match, variable) => {
      const index = variables.indexOf(variable);
      return updatedVariables[index];
    });

    setContent(newContent);

    if (textareaRef && textareaRef.current) {
      textareaRef.current.focus();
    }
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
        const fullBase64String = loadEvent.target?.result;
        processFile({ fullBase64String, file })
      };
      reader.readAsDataURL(file);

    }
  };

  const handlePaste = (event: { clipboardData: any; originalEvent: { clipboardData: any; }; }) => {
    const clipboardData = event.clipboardData || event.originalEvent.clipboardData;
    let items = clipboardData.items;
    let isImagePasted = false;

    if (items) {
      for (const item of items) {
        if (item.type.indexOf("image") === 0) {
          isImagePasted = true;
          const file = item.getAsFile();
          // Reading the image as Data URL (base64)
          const reader = new FileReader();
          reader.onload = (loadEvent) => {
            const fullBase64String = loadEvent.target?.result;
            processFile({ fullBase64String, file })
          };
          reader.readAsDataURL(file);
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
      textareaRef.current.style.overflow = `${textareaRef?.current?.scrollHeight > 400 ? 'auto' : 'hidden'
        }`;
    }
  }, [content, textareaRef]);

  const handleSpeechToText = useCallback(() => {
    if (!recognitionRef.current) {
      const SpeechRecognition =
        window?.SpeechRecognition || window?.webkitSpeechRecognition;

      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.lang = 'en-US';
      recognitionRef.current.interimResults = true;
      recognitionRef.current.continuous = true;

      recognitionRef.current.onresult = (event) => {
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
      recordingStartSound.play();
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

  return (
    <div
      className="sticky bottom-0 left-0 right-0 z-30 border-transparent bg-gradient-to-t from-bg-secondary via-bg-secondary/95 to-bg-secondary/0 pb-6 pt-6 dark:from-dark-bg-primary dark:via-dark-bg-primary/95 dark:to-dark-bg-primary/0"
      style={{
        paddingBottom: `calc(24px + env(safe-area-inset-bottom))`,
      }}
    >
      <div className="stretch mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 sm:px-6">
        <div className="-mt-6 flex justify-center items-center gap-3">
          {messageIsStreaming ? (
            <button
              className="inline-flex items-center gap-2 rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-neutral-800 dark:bg-nvidia-green dark:text-neutral-900"
              onClick={handleStopConversation}
            >
              <IconPlayerStop size={14} /> {t('Stop Generating')}
            </button>
          ) : (
            selectedConversation &&
            selectedConversation.messages.length > 1 && (
              <button
                className="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-bg-primary px-4 py-2 text-sm font-medium text-text-primary shadow-sm transition-colors duration-150 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:bg-dark-bg-tertiary dark:text-neutral-100 dark:hover:border-neutral-600"
                onClick={onRegenerate}
              >
                <IconRepeat size={14} /> {t('Regenerate response')}
              </button>
            )
          )}
          {!messageIsStreaming && (
            <button
              className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium shadow-sm transition-colors duration-150 ${
                useDeepThinker
                  ? 'border-nvidia-green bg-bg-primary text-nvidia-green hover:border-nvidia-green/80 dark:border-nvidia-green dark:bg-dark-bg-tertiary dark:text-nvidia-green'
                  : 'border-neutral-200 bg-bg-primary text-text-primary hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:bg-dark-bg-tertiary dark:text-neutral-100 dark:hover:border-neutral-600'
              }`}
              onClick={() => setUseDeepThinker(!useDeepThinker)}
              title="Enable deep philosophical analysis with first-principles reasoning"
            >
              <IconBrain size={14} /> Deep Thinker {useDeepThinker ? 'ON' : 'OFF'}
            </button>
          )}
        </div>

        <div className="relative mx-auto flex w-full max-w-5xl flex-grow flex-col rounded-3xl border border-neutral-200/70 bg-bg-primary/95 px-4 py-3 shadow-[0_10px_40px_rgba(15,23,42,0.08)] backdrop-blur supports-[backdrop-filter]:bg-bg-primary/80 dark:border-neutral-700 dark:bg-dark-bg-tertiary/90 dark:text-white">
          <textarea
            ref={textareaRef}
            className="m-0 w-full resize-none border-0 bg-transparent py-4 pr-12 pl-12 text-[15px] leading-relaxed text-neutral-900 outline-none placeholder:text-neutral-400 focus:outline-none dark:bg-transparent dark:text-white"
            style={{
              resize: 'none',
              bottom: `${textareaRef?.current?.scrollHeight}px`,
              minHeight: '54px',
              maxHeight: '320px',
              overflow: `${textareaRef.current && textareaRef.current.scrollHeight > 400 ? 'auto' : 'hidden'}`,
            }}
            placeholder={isRecording ? 'Listening…' : t('Send a message')}
            value={content}
            rows={1}
            onCompositionStart={() => setIsTyping(true)}
            onCompositionEnd={() => setIsTyping(false)}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            {...(appConfig?.fileUploadEnabled && {
              onDragOver: handleDragOver,
              onDrop: handleDrop,
              onPaste: handlePaste,
            })}
          />
          {inputFile && (imageRef || inputFileContentCompressed) &&
            <div>
              <div className="relative right-0 top-0 flex flex-col gap-2 rounded-2xl border border-neutral-200 bg-neutral-50 p-3 text-black shadow-sm dark:border-neutral-600 dark:bg-dark-bg-primary dark:text-white">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <IconPhoto className="ml-2 text-neutral-600 dark:text-neutral-200" size={16} />
                    <span className="text-sm font-medium text-neutral-700 dark:text-neutral-50">{inputFile}</span>
                    {isUploadingImage && <span className="text-xs text-neutral-500">Uploading…</span>}
                  </div>
                  <IconTrash
                    className="cursor-pointer text-neutral-400 transition-colors duration-150 hover:text-red-500"
                    size={18}
                    onClick={handleInputFileDelete as unknown as any}
                  />
                </div>
                {/* Show preview using OptimizedImage */}
                {imageRef && (
                  <div className="mx-auto max-w-[220px]">
                    <OptimizedImage
                      imageRef={imageRef}
                      alt={inputFile}
                      className="rounded-xl"
                    />
                  </div>
                )}
              </div>
            </div>
          }
          {
            appConfig?.fileUploadEnabled && !inputFile &&
            <>
              <button
            className="absolute right-12 top-1/2 -translate-y-1/2 rounded-full p-2 text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-dark-bg-primary/60"
                onClick={triggerFileUpload}
                disabled={isUploadingImage}
              >
                {messageIsStreaming || isUploadingImage ? (
                  <></>
                ) : (
                  <>
                    <IconPaperclip size={18} />
                  </>
                )}
              </button>
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: 'none' }}
                onChange={handleFileChange}
              />
            </>
          }
          <button
            onClick={handleSpeechToText}
            className={`absolute left-3 top-1/2 -translate-y-1/2 rounded-full p-2 text-neutral-500 transition-colors duration-150 dark:text-neutral-300 ${messageIsStreaming
              ? 'text-neutral-400'
              : 'hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-dark-bg-primary/60'
              }`}
            disabled={messageIsStreaming}
          >
            {isRecording ? (
              <IconPlayerStopFilled size={18} className="text-red-500 animate-blink" />
            ) : (
              <IconMicrophone size={18} />
            )}
          </button>
          <button
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-neutral-900 p-2 text-white transition-transform duration-150 hover:scale-105 dark:bg-nvidia-green"
            onClick={handleSend}
          >
            {messageIsStreaming ? (
              <div className="h-4 w-4 animate-spin rounded-full border-t-2 border-neutral-800 opacity-60 dark:border-neutral-100"></div>
            ) : (
              <IconSend size={18} />
            )}
          </button>

          {showScrollDownButton && (
            <div className="pointer-events-none absolute -top-14 right-0 flex items-center justify-end">
              <button
                className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-neutral-200 bg-bg-primary text-text-primary shadow-md transition-colors duration-150 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:bg-dark-bg-tertiary dark:text-neutral-200 dark:hover:border-neutral-600"
                onClick={onScrollDownClick}
                aria-label={t('Scroll to bottom')}
              >
                <IconArrowDown size={18} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
