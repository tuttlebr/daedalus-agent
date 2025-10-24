'use client';
import {
  IconBrain,
  IconCheck,
  IconCopy,
  IconPaperclip,
  IconPlayerPause,
  IconUser,
  IconVolume2,
  IconClock,
} from '@tabler/icons-react';
import classNames from 'classnames';
import { FC, memo, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Message } from '@/types/chat';
import HomeContext from '@/pages/api/home/home.context';
import { MemoizedReactMarkdown } from '../Markdown/MemoizedReactMarkdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { BotAvatar } from '@/components/Avatar/BotAvatar';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { getReactMarkDownCustomComponents } from '../Markdown/CustomComponents';
import { fixMalformedHtml } from '@/utils/app/helper';
import { OptimizedImage } from './OptimizedImage';
import { IntermediateSteps } from '../IntermediateSteps/IntermediateSteps';

export interface Props {
  message: Message;
  messageIndex: number;
}

export const ChatMessage: FC<Props> = memo(({ message, messageIndex }) => {
  const hasPrimaryContent = Boolean(message?.content?.trim());
  const hasIntermediateSteps = Boolean(message?.intermediateSteps?.length);

  if (!hasPrimaryContent && !hasIntermediateSteps) {
    return null;
  }

  const {
    state: { messageIsStreaming },
  } = useContext(HomeContext);

  const [messagedCopied, setMessageCopied] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const speechSynthesisRef = useRef<SpeechSynthesisUtterance | null>(null);

  const isAssistantMessage = message.role === 'assistant';

  const cx = (...classes: Array<string | false | null | undefined>) =>
    classes.filter(Boolean).join(' ');

  const prepareContent = ({
    message: contentMessage = {} as Partial<Message>,
    responseContent = true,
    intermediateStepsContent = false,
    role = 'assistant',
  }: {
    message?: Partial<Message>;
    responseContent?: boolean;
    intermediateStepsContent?: boolean;
    role?: 'assistant' | 'user';
  } = {}) => {
    const { content = '', intermediateSteps = [] } = contentMessage;

    if (role === 'user') return content.trim();

    let result = '';
    // Intermediate steps are now handled by the IntermediateSteps component
    if (responseContent) {
      result = content;
    }

    // fixing malformed html and removing extra spaces to avoid markdown issues
    return fixMalformedHtml(result)?.trim()?.replace(/\n\s+/, '\n ');
  };

  const copyText = useMemo(() => {
    if (message.role === 'user') {
      return prepareContent({ message, role: 'user' });
    }

    // For assistant messages, we now only copy the main content
    // Intermediate steps are too complex to copy as plain text
    return prepareContent({
      message,
      role: 'assistant',
      intermediateStepsContent: false,
      responseContent: true,
    });
  }, [message]);

  const copyOnClick = useCallback(() => {
    if (!navigator.clipboard || !copyText) return;

    navigator.clipboard.writeText(copyText).then(() => {
      setMessageCopied(true);
      setTimeout(() => {
        setMessageCopied(false);
      }, 2000);
    });
  }, [copyText]);

  const removeLinks = useCallback((text: string) => {
    // This regex matches http/https URLs
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.replace(urlRegex, '');
  }, []);

  const handleTextToSpeech = useCallback(() => {
    if (!copyText) return;

    if ('speechSynthesis' in window) {
      if (isPlaying) {
        window.speechSynthesis.cancel();
        setIsPlaying(false);
      } else {
        const textWithoutLinks = removeLinks(copyText);
        const utterance = new SpeechSynthesisUtterance(textWithoutLinks);
        utterance.onend = () => setIsPlaying(false);
        utterance.onerror = () => setIsPlaying(false);
        speechSynthesisRef.current = utterance;
        setIsPlaying(true);
        window.speechSynthesis.speak(utterance);
      }
    } else {
      console.log('Text-to-speech is not supported in your browser.');
    }
  }, [copyText, isPlaying, removeLinks]);

  useEffect(() => {
    return () => {
      if (speechSynthesisRef.current) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const wrapperClasses = cx('group px-3 sm:px-4 md:px-6');

  const rowClasses = cx(
    'mx-auto flex w-full gap-2 sm:gap-3 py-1.5 sm:py-2',
    hasIntermediateSteps && message.role === 'assistant' ? 'max-w-7xl' : 'max-w-5xl',
    message.role === 'user' ? 'flex-row-reverse' : 'flex-row'
  );

  const avatarWrapperClasses = cx(
    'flex-shrink-0',
    message.role === 'assistant' ? 'self-end mb-1' : 'self-end mb-1',
    'hidden sm:block' // Hide avatars on mobile for more space
  );

  const bubbleClasses = cx(
    'relative',
    hasIntermediateSteps && isAssistantMessage ? 'max-w-full' : 'max-w-[85%] sm:max-w-[75%] md:max-w-[65%]',
    'px-3 py-2 sm:px-4 sm:py-3',
    'text-[14px] sm:text-[15px] leading-relaxed',
    'break-words transition-all duration-200 animate-scale-in',
    isAssistantMessage
      ? 'rounded-2xl rounded-bl-md glass text-gray-900 dark:text-gray-100 shadow-sm'
      : 'rounded-2xl rounded-br-md bg-nvidia-green-dark backdrop-blur-sm text-white shadow-md hover:shadow-glow-green hover:bg-nvidia-green',
    'hover:shadow-lg'
  );

  const markdownBaseClasses = cx(
    'prose prose-neutral max-w-none break-words text-[15px] leading-relaxed dark:prose-invert',
    '[&>*]:max-w-full [&_*]:break-words',
    '[&_pre]:max-w-full [&_pre]:overflow-x-auto',
    '[&_code]:break-words [&_code]:whitespace-pre-wrap',
    '[&_table]:w-full [&_table]:table-fixed'
  );

  const actionBarClasses = cx(
    'flex items-center gap-1 sm:gap-2 text-[10px] sm:text-xs font-medium',
    'mt-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200',
    'text-gray-500 dark:text-gray-400',
    message.role === 'user' ? 'justify-end pr-2' : 'justify-start pl-2'
  );

  const attachmentWrapperClasses = cx(
    'mt-3 flex flex-wrap gap-3',
    message.role === 'assistant' ? 'justify-start' : 'justify-end'
  );

  // Add timestamp formatting
  const formatTime = useCallback(() => {
    const date = new Date();
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }, []);

  return (
    <div className={wrapperClasses}>
      <div className={rowClasses} style={{ overflowWrap: 'anywhere' }}>
        <div className={avatarWrapperClasses}>
          {isAssistantMessage ? <BotAvatar src={'favicon.png'} height={24} width={24} /> : <IconUser size={24} className="text-gray-600 dark:text-gray-400" />}
        </div>

        <div className={cx('flex min-w-0 flex-1 flex-col', isAssistantMessage ? 'items-start' : 'items-end')}>
          {/* Deep Thinker mode badge for user messages */}
          {message.role === 'user' && (message as any).metadata?.useDeepThinker && (
            <div className="mb-1 flex items-center gap-1.5 px-2 py-1 rounded-full bg-nvidia-green/10 border border-nvidia-green/30 text-xs text-nvidia-green dark:bg-nvidia-green/20 dark:border-nvidia-green/40">
              <IconBrain size={12} />
              <span className="font-medium">Deep Thinker</span>
            </div>
          )}
          <div className={bubbleClasses}>
            {/* Message time and status */}
            {message.role === 'user' && (
              <div className="flex items-center gap-1 justify-end mt-1 text-[10px] text-white/70">
                <span>{formatTime()}</span>
                <span className="flex gap-0.5">
                  {/* Message status indicators */}
                  <IconCheck size={12} className="text-white/70" />
                  <IconCheck size={12} className="text-white/70 -ml-2" />
                </span>
              </div>
            )}
            {message.role === 'user' ? (
              <div className={markdownBaseClasses}>
                <ReactMarkdown
                  className="prose dark:prose-invert"
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeRaw] as any}
                  linkTarget="_blank"
                  components={getReactMarkDownCustomComponents(messageIndex, message?.id)}
                >
                  {prepareContent({ message, role: 'user' })}
                </ReactMarkdown>
                {message.attachments && message.attachments.length > 0 && (
                  <div className={attachmentWrapperClasses}>
                    {message.attachments.map((attachment, idx) => {
                      if (attachment.type === 'image' && attachment.imageRef) {
                        return (
                          <div key={idx} className="max-w-[220px] sm:max-w-xs">
                            <OptimizedImage
                              imageRef={attachment.imageRef}
                              alt="User attachment"
                              className="rounded-lg shadow-sm"
                            />
                          </div>
                        );
                      } else if (attachment.type === 'pdf' && attachment.pdfRef) {
                        return (
                          <div key={idx} className="inline-flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-2 dark:bg-gray-800">
                            <IconPaperclip size={16} className="text-gray-600 dark:text-gray-400" />
                            <span className="text-sm text-gray-700 dark:text-gray-300">
                              PDF: {attachment.pdfRef.filename || 'Document'}
                            </span>
                          </div>
                        );
                      }
                      return null;
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex w-full flex-col gap-4">
                {/* Render intermediate steps using the new component */}
                {message.intermediateSteps && message.intermediateSteps.length > 0 && (
                  <div className="-mx-3 sm:-mx-4 -my-2 sm:-my-3">
                    <IntermediateSteps
                      steps={message.intermediateSteps}
                      className="mb-2 mx-0 max-w-none"
                    />
                  </div>
                )}

                <MemoizedReactMarkdown
                  key={`msg-${message?.id}-${message?.content?.includes('/api/session/imageStorage') ? 'stored' : 'raw'}`}
                  className={markdownBaseClasses}
                  rehypePlugins={[rehypeRaw] as any}
                  remarkPlugins={[
                    remarkGfm,
                    [remarkMath, { singleDollarTextMath: false }],
                  ]}
                  linkTarget="_blank"
                  components={getReactMarkDownCustomComponents(messageIndex, message?.id)}
                >
                  {prepareContent({
                    message,
                    role: 'assistant',
                    intermediateStepsContent: false,
                    responseContent: true,
                  })}
                </MemoizedReactMarkdown>
              </div>
            )}
          </div>

          {!messageIsStreaming && copyText && (
            <div className={actionBarClasses}>
              <button
                className={classNames(
                  'inline-flex items-center gap-1 rounded-full border border-transparent px-3 py-1 text-xs transition-colors duration-150',
                  'bg-[var(--action-button-bg)] text-[var(--action-button-text)] hover:bg-[var(--action-button-hover-bg)]',
                  'dark:bg-[var(--action-button-bg-dark)] dark:text-[var(--action-button-text-dark)] dark:hover:bg-[var(--action-button-hover-bg-dark)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-neutral-400'
                )}
                onClick={copyOnClick}
                aria-label="Copy message"
                id={message?.id}
              >
                {messagedCopied ? (
                  <IconCheck size={18} className="text-nvidia-green dark:text-nvidia-green" />
                ) : (
                  <IconCopy size={18} />
                )}
                <span className="hidden sm:inline">Copy</span>
              </button>

              {isAssistantMessage && hasPrimaryContent && (
                <button
                  className={classNames(
                    'inline-flex items-center gap-1 rounded-full border border-transparent px-3 py-1 text-xs transition-colors duration-150',
                    'bg-[var(--action-button-bg)] text-[var(--action-button-text)] hover:bg-[var(--action-button-hover-bg)]',
                    'dark:bg-[var(--action-button-bg-dark)] dark:text-[var(--action-button-text-dark)] dark:hover:bg-[var(--action-button-hover-bg-dark)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-neutral-400'
                  )}
                  onClick={handleTextToSpeech}
                  aria-label={isPlaying ? 'Stop speaking' : 'Play message'}
                >
                  {isPlaying ? (
                    <IconPlayerPause size={18} className="text-red-400" />
                  ) : (
                    <IconVolume2 size={18} />
                  )}
                  <span className="hidden sm:inline">Listen</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
ChatMessage.displayName = 'ChatMessage';
