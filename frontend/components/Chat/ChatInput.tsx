import {
  IconArrowDown,
  IconBolt,
  IconPaperclip,
  IconPhoto,
  IconPlayerStop,
  IconRepeat,
  IconSend,
  IconTrash,
  IconMicrophone,
  IconPlayerStopFilled,
  IconMicrophone2,
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
import { compressImage, getWorkflowName } from '@/utils/app/helper';
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
  controller
}: Props) => {
  const { t } = useTranslation('chat');

  const {
    state: { selectedConversation, messageIsStreaming, loading, webSocketMode },
    dispatch: homeDispatch,
  } = useContext(HomeContext);

  const workflow = getWorkflowName()

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
  const recognitionRef = useRef(null);

  const triggerFileUpload = () => {
    fileInputRef?.current.click();
  };

  const handleInputFileDelete = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
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

    if (inputFile || imageRef) {
      onSend({
        role: 'user',
        content: content,
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
      onSend({ role: 'user', content })
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
    if(webSocketMode) {
      console.log('stop conversation is yet to be implemented');
      homeDispatch({ field: 'loading', value: false });
      homeDispatch({ field: 'messageIsStreaming', value: false });
      return
    }
    else {
      try {
        controller?.current?.abort('aborted');
        setTimeout(() => {
          controller.current = new AbortController(); // Reset the controller
        }, 100);
      } catch (error) {
        console.log('error aborting - ', error);
      }
    }
  };

  const isMobile = () => {
    const userAgent =
      typeof window.navigator === 'undefined' ? '' : navigator.userAgent;
    const mobileRegex =
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;
    return mobileRegex.test(userAgent);
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
      handleInputFileDelete(null as any);
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
      className={`absolute bottom-0 left-0 w-full border-transparent bg-white dark:bg-dark-bg-primary pt-8 dark:border-white/20 ${isMobile() ? 'pb-[calc(24px+env(safe-area-inset-bottom))]' : 'pb-[calc(24px+env(safe-area-inset-bottom))]'}`}
      style={{ paddingBottom: `calc(24px + env(safe-area-inset-bottom))` }}
    >
      <div className="stretch mx-3 mt-5 flex flex-row gap-4 last:mb-2 md:mx-4 md:mt-[52px] md:gap-3 2xl:mx-auto 2xl:max-w-5xl">
        {messageIsStreaming && (
          <button
            className="absolute top-0 left-0 right-0 mx-auto mb-3 flex w-fit items-center gap-3 rounded border border-neutral-200 bg-white py-2 px-4 text-black hover:opacity-50 dark:border-neutral-600 dark:bg-dark-bg-primary dark:text-white md:mb-0 md:mt-2"
            onClick={handleStopConversation}
          >
            <IconPlayerStop size={16} /> {t('Stop Generating')}
          </button>
        )}

        {!messageIsStreaming &&
          selectedConversation &&
          selectedConversation.messages.length > 1 &&
          // selectedConversation.messages[selectedConversation.messages.length - 1].role === 'assistant' &&
          (
            <button
              className="absolute top-0 left-0 right-0 mx-auto mb-3 flex w-fit items-center gap-3 rounded border border-neutral-200 bg-white py-2 px-4 text-black hover:opacity-50 dark:border-neutral-600 dark:bg-dark-bg-primary dark:text-white md:mb-0 md:mt-2"
              onClick={onRegenerate}
            >
              <IconRepeat size={16} /> {t('Regenerate response')}
            </button>
          )}

        <div className="relative mx-3 sm:mx-4 flex w-[calc(100%-1.5rem)] sm:w-full flex-grow flex-col rounded-xl border border-black/10 bg-white shadow-[0_0_12px_rgba(0,0,0,0.12)] dark:border-gray-900/50 dark:bg-dark-bg-tertiary dark:text-white dark:shadow-[0_0_18px_rgba(0,0,0,0.12)] md:rounded-lg">
          <textarea
            ref={textareaRef}
            className="m-0 w-full resize-none border-0 sm:p-3 sm:pl-8 bg-transparent p-0 py-4 pr-11 pl-12 text-black dark:bg-transparent dark:text-white md:py-3 md:pl-10 outline-none"
            style={{
              resize: 'none',
              bottom: `${textareaRef?.current?.scrollHeight}px`,
              minHeight: '48px',
              maxHeight: '320px',
              overflow: `${textareaRef.current && textareaRef.current.scrollHeight > 400 ? 'auto' : 'hidden'}`,
            }}
            placeholder={isRecording ? 'Listening...' : ``}
            value={content}
            rows={1}
            onCompositionStart={() => setIsTyping(true)}
            onCompositionEnd={() => setIsTyping(false)}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            {...(appConfig?.fileUploadEnabled && {
              onDragOver: handleDragOver,
              onDrop: handleDrop,
              onPaste: handlePaste
            })}
          />
          {inputFile && (imageRef || inputFileContentCompressed) &&
            <div>
              <div className="relative right-0 top-0 p-3 bg-nvidia-green-light dark:bg-green-700 text-black dark:text-white flex flex-col gap-2 rounded-lg">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <IconPhoto className="ml-8" size={16} />
                    <span className="text-sm">{inputFile}</span>
                    {isUploadingImage && <span className="text-xs opacity-75">Uploading...</span>}
                  </div>
                  <IconTrash
                    className="hover:text-[#ff1717e9] cursor-pointer"
                    size={18}
                    onClick={handleInputFileDelete}
                  />
                </div>
                {/* Show preview using OptimizedImage */}
                {imageRef && (
                  <div className="max-w-[200px] mx-auto">
                    <OptimizedImage
                      imageRef={imageRef}
                      alt={inputFile}
                      className="rounded-md"
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
                className="absolute right-12 top-3 rounded-md p-2 text-neutral-800 opacity-60 hover:text-nvidia-green dark:bg-opacity-50 dark:text-neutral-100 dark:hover:text-neutral-200"
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
            className={`absolute left-3 top-3 rounded-md p-2 text-neutral-800 opacity-60 dark:bg-opacity-50 dark:text-neutral-100 ${messageIsStreaming
              ? 'text-neutral-400' // Disable hover and change color when streaming
              : 'hover:text-nvidia-green dark:hover:text-neutral-200' // Normal hover effect
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
            className="absolute right-3 top-3 rounded-md p-2 text-neutral-800 opacity-60 hover:bg-neutral-200 hover:text-neutral-900 dark:bg-opacity-50 dark:text-neutral-100 dark:hover:text-neutral-200"
            onClick={handleSend}
          >
            {messageIsStreaming ? (
              <div className="h-4 w-4 animate-spin rounded-full border-t-2 border-neutral-800 opacity-60 dark:border-neutral-100"></div>
            ) : (
              <IconSend size={18} />
            )}
          </button>

          {showScrollDownButton && (
            <div className="absolute bottom-[calc(3rem+env(safe-area-inset-bottom))] right-2 lg:bottom-2 lg:-right-10">
              <button
                className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-300 text-gray-800 shadow-md hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-neutral-200"
                onClick={onScrollDownClick}
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
