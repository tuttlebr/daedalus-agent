'use client';
import {
  IconBrain,
  IconCheck,
  IconCopy,
  IconPlayerPause,
  IconUser,
  IconVolume2,
} from '@tabler/icons-react';
import classNames from 'classnames';
import { FC, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Message } from '@/types/chat';
import HomeContext from '@/pages/api/home/home.context';
import { MemoizedReactMarkdown } from '../Markdown/MemoizedReactMarkdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { BotAvatar } from '@/components/Avatar/BotAvatar';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { getReactMarkDownCustomComponents } from '../Markdown/CustomComponents';
import { fixMalformedHtml, generateContentIntermediate } from '@/utils/app/helper';
import { OptimizedImage } from './OptimizedImage';

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
    if (intermediateStepsContent) {
      result += generateContentIntermediate(intermediateSteps);
    }

    if (responseContent) {
      result += result ? `\n\n${content}` : content;
    }

    // fixing malformed html and removing extra spaces to avoid markdown issues
    return fixMalformedHtml(result)?.trim()?.replace(/\n\s+/, '\n ');
  };

  const copyText = useMemo(() => {
    if (message.role === 'user') {
      return prepareContent({ message, role: 'user' });
    }

    return prepareContent({
      message,
      role: 'assistant',
      intermediateStepsContent: true,
      responseContent: true,
    });
  }, [message]);

  const copyOnClick = () => {
    if (!navigator.clipboard || !copyText) return;

    navigator.clipboard.writeText(copyText).then(() => {
      setMessageCopied(true);
      setTimeout(() => {
        setMessageCopied(false);
      }, 2000);
    });
  };

  const removeLinks = (text: string) => {
    // This regex matches http/https URLs
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.replace(urlRegex, '');
  };

  const handleTextToSpeech = () => {
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
  };

  useEffect(() => {
    return () => {
      if (speechSynthesisRef.current) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const wrapperClasses = cx('group px-3 sm:px-4 md:px-6');

  const rowClasses = cx(
    'mx-auto flex w-full max-w-3xl gap-3 sm:gap-4 md:gap-5 py-4',
    message.role === 'user' ? 'flex-row-reverse' : 'flex-row'
  );

  const avatarWrapperClasses = cx(
    'flex-shrink-0 pt-1',
    message.role === 'assistant' ? 'text-right' : 'text-left'
  );

  const bubbleClasses = cx(
    'relative w-full max-w-full rounded-2xl border px-4 py-3 text-[15px] leading-relaxed shadow-sm transition-colors duration-200',
    'backdrop-blur supports-[backdrop-filter]:bg-white/90',
    'overflow-hidden',
    isAssistantMessage
      ? 'self-start border-[var(--chat-bubble-assistant-border)] bg-[var(--chat-bubble-assistant-bg)] text-gray-900 dark:border-[var(--chat-bubble-assistant-border-dark)] dark:bg-[var(--chat-bubble-assistant-bg-dark)] dark:text-gray-100'
      : 'self-end border-[var(--chat-bubble-user-border)] bg-[var(--chat-bubble-user-bg)] text-gray-900 dark:border-[var(--chat-bubble-user-border-dark)] dark:bg-[var(--chat-bubble-user-bg-dark)] dark:text-gray-50'
  );

  const markdownBaseClasses = cx(
    'prose prose-neutral max-w-none break-words text-[15px] leading-relaxed dark:prose-invert',
    '[&>*]:max-w-full [&_*]:break-words',
    '[&_pre]:max-w-full [&_pre]:overflow-x-auto',
    '[&_code]:break-words [&_code]:whitespace-pre-wrap',
    '[&_table]:w-full [&_table]:table-fixed'
  );

  const actionBarClasses = cx(
    'flex items-center gap-2 text-xs font-medium text-neutral-500 transition-opacity duration-150 dark:text-neutral-300',
    'mt-3',
    isAssistantMessage ? 'justify-end' : 'justify-start sm:justify-end'
  );

  const attachmentWrapperClasses = cx(
    'mt-3 flex flex-wrap gap-3',
    message.role === 'assistant' ? 'justify-start' : 'justify-end'
  );

  return (
    <div className={wrapperClasses}>
      <div className={rowClasses} style={{ overflowWrap: 'anywhere' }}>
        <div className={avatarWrapperClasses}>
          {isAssistantMessage ? <BotAvatar src={'favicon.png'} /> : <IconUser size={30} />}
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
                      }
                      return null;
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex w-full flex-col gap-4">
                {prepareContent({
                  message,
                  role: 'assistant',
                  intermediateStepsContent: true,
                  responseContent: false,
                }) && (
                  <MemoizedReactMarkdown
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
                      intermediateStepsContent: true,
                      responseContent: false,
                    })}
                  </MemoizedReactMarkdown>
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
