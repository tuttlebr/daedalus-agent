'use client';
import {
  IconBrain,
  IconCheck,
  IconCopy,
  IconPaperclip,
  IconUser,
  IconClock,
  IconVideo,
  IconInfoCircle,
} from '@tabler/icons-react';
import classNames from 'classnames';
import { FC, memo, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Message } from '@/types/chat';
import HomeContext from '@/pages/api/home/home.context';
import { MemoizedReactMarkdown } from '../Markdown/MemoizedReactMarkdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { BotAvatar } from '@/components/Avatar/BotAvatar';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { sanitizeSchema } from '@/utils/app/sanitizeSchema';
import { getReactMarkDownCustomComponents } from '../Markdown/CustomComponents';
import { fixMalformedHtml } from '@/utils/app/helper';
import { OptimizedImage } from './OptimizedImage';
import { DocumentBadge } from './DocumentBadge';
import { ImageGallery } from './ImageGallery';
import { getVideoUrl } from '@/utils/app/videoHandler';
import dynamic from 'next/dynamic';
const IntermediateSteps = dynamic(
  () => import('../IntermediateSteps/IntermediateSteps').then(mod => ({ default: mod.IntermediateSteps })),
  { ssr: false },
);
import { ErrorRecovery, categorizeError } from './ErrorRecovery';
import { normalizeLatexDelimiters } from '@/utils/app/latexNormalizer';

export interface Props {
  message: Message;
  messageIndex: number;
  onRetry?: () => void;
}

export const ChatMessage: FC<Props> = memo(({ message, messageIndex, onRetry }) => {
  // Ensure content is always a string to prevent React error #300
  const messageContent = typeof message?.content === 'string' ? message.content : '';
  const hasPrimaryContent = Boolean(messageContent.trim());
  const hasIntermediateSteps = Boolean(message?.intermediateSteps?.length);
  const hasError = Boolean(message?.errorMessages);

  if (!hasPrimaryContent && !hasIntermediateSteps && !hasError) {
    return null;
  }

  // Use the validated string content throughout
  const safeMessage = { ...message, content: messageContent };

  const {
    state: { messageIsStreaming, streamingByConversationId, selectedConversation },
  } = useContext(HomeContext);
  const isSelectedConversationStreaming = Boolean(
    selectedConversation?.id && streamingByConversationId[selectedConversation.id]
  );
  const resolvedIsStreaming = messageIsStreaming && isSelectedConversationStreaming;

  const [messagedCopied, setMessageCopied] = useState(false);

  const isAssistantMessage = message.role === 'assistant';
  const isSystemMessage = message.role === 'system';
  const DOCUMENT_EXTRACT_START = '<!-- DOCUMENT_EXTRACT_START -->';
  const DOCUMENT_EXTRACT_END = '<!-- DOCUMENT_EXTRACT_END -->';

  const splitExtractedBlock = useCallback((content: string) => {
    const startIndex = content.indexOf(DOCUMENT_EXTRACT_START);
    if (startIndex === -1) {
      return { main: content.trim(), extracted: '' };
    }
    const endIndex = content.indexOf(DOCUMENT_EXTRACT_END, startIndex + DOCUMENT_EXTRACT_START.length);
    if (endIndex === -1) {
      return { main: content.trim(), extracted: '' };
    }
    const extracted = content
      .slice(startIndex + DOCUMENT_EXTRACT_START.length, endIndex)
      .trim();
    const main = `${content.slice(0, startIndex)}${content.slice(endIndex + DOCUMENT_EXTRACT_END.length)}`
      .trim();
    return { main, extracted };
  }, []);

  // Render system messages as subtle log-style indicators
  if (isSystemMessage) {
    return (
      <div className="mx-auto flex w-full max-w-5xl justify-center px-3 py-1.5 sm:px-4">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium text-neutral-500 dark:text-neutral-400 bg-neutral-100/60 dark:bg-neutral-800/40 border border-neutral-200/50 dark:border-neutral-700/30 backdrop-blur-sm">
          <IconInfoCircle size={12} className="opacity-60" />
          <span className="opacity-80">{messageContent}</span>
        </div>
      </div>
    );
  }

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

    if (role === 'user') {
      const normalized = normalizeLatexDelimiters(content.trim());
      return normalized;
    }

    let result = '';
    // Intermediate steps are now handled by the IntermediateSteps component
    if (responseContent) {
      result = content;
    }

    // fixing malformed html during streaming (incomplete img/video tags)
    const fixed = fixMalformedHtml(result)?.trim();
    // Normalize LaTeX delimiters for assistant messages
    return normalizeLatexDelimiters(fixed || '');
  };

  const copyText = useMemo(() => {
    if (safeMessage.role === 'user') {
      return prepareContent({ message: safeMessage, role: 'user' });
    }

    // For assistant messages, we now only copy the main content
    // Intermediate steps are too complex to copy as plain text
    const prepared = prepareContent({
      message: safeMessage,
      role: 'assistant',
      intermediateStepsContent: false,
      responseContent: true,
    });
    const { main, extracted } = splitExtractedBlock(prepared);
    if (!extracted) {
      return main;
    }
    return `${main}\n\n[Extracted text]\n${extracted}`;
  }, [safeMessage, splitExtractedBlock]);

  const copyOnClick = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.clipboard || !copyText) return;

    navigator.clipboard.writeText(copyText).then(() => {
      setMessageCopied(true);
      setTimeout(() => {
        setMessageCopied(false);
      }, 2000);
    });
  }, [copyText]);

  const wrapperClasses = cx('group px-3 sm:px-4 md:px-6 py-2 sm:py-3', 'min-w-0', 'max-w-full', 'overflow-hidden');

  const rowClasses = cx(
    'mx-auto flex w-full gap-2 sm:gap-3 py-1.5 sm:py-2',
    hasIntermediateSteps && message.role === 'assistant' ? 'max-w-7xl' : 'max-w-5xl',
    message.role === 'user' ? 'flex-row-reverse justify-end pl-6 sm:pl-12' : 'flex-row justify-start pr-8 sm:pr-14',
    'min-w-0', // Prevent flex overflow
    'max-w-full' // Ensure it doesn't exceed container
  );

  const avatarWrapperClasses = cx(
    'flex-shrink-0',
    message.role === 'assistant' ? 'self-end mb-1' : 'self-end mb-1',
    'hidden sm:block' // Hide avatars on mobile for more space
  );

  const bubbleClasses = cx(
    'relative',
    hasIntermediateSteps && isAssistantMessage ? 'max-w-full' : 'max-w-[85%] sm:max-w-[75%] md:max-w-[65%]',
    'px-4 py-3 sm:px-5 sm:py-4',
    'text-[15px] sm:text-[15.5px] leading-relaxed',
    'break-words',
    'overflow-wrap-anywhere',
    'transition-all duration-200',
    // Use directional animations based on role
    isAssistantMessage ? 'animate-message-left' : 'animate-message-right',
    'min-w-0',
    isAssistantMessage
      ? 'rounded-3xl rounded-bl-lg bg-[color:var(--chat-bubble-assistant-bg)] dark:bg-[color:var(--chat-bubble-assistant-bg-dark)] text-gray-900 dark:text-gray-50 shadow-sm border border-[color:var(--chat-bubble-assistant-border)] dark:border-[color:var(--chat-bubble-assistant-border-dark)] mr-auto'
      : 'rounded-3xl rounded-br-lg bg-[color:var(--chat-bubble-user-bg-flat)] dark:bg-[color:var(--chat-bubble-user-bg-dark-flat)] text-gray-900 dark:text-gray-50 shadow-sm border border-[color:var(--chat-bubble-user-border)] dark:border-[color:var(--chat-bubble-user-border-dark)] ml-auto',
    'hover:shadow-lg'
  );

  const markdownBaseClasses = cx(
    'prose prose-neutral max-w-none break-words text-[15px] leading-relaxed dark:prose-invert',
    '[&>*]:max-w-full [&_*]:break-words',
    '[&_pre]:max-w-full [&_pre]:overflow-x-auto',
    '[&_code]:break-words [&_code]:whitespace-pre-wrap',
    '[&_table]:w-full [&_table]:max-w-full [&_table]:table-fixed [&_table]:overflow-hidden',
    '[&_img]:max-w-full [&_img]:h-auto',
    'overflow-wrap-anywhere'
  );

  const actionBarClasses = cx(
    'flex items-center gap-1.5 sm:gap-2 text-[10px] sm:text-xs font-medium',
    'mt-2 opacity-0 group-hover:opacity-100 transition-all duration-250',
    'text-gray-500 dark:text-gray-400',
    message.role === 'user' ? 'justify-end pr-2' : 'justify-start pl-2'
  );

  // Action button class for copy, listen, etc.
  const actionButtonClasses = cx(
    'flex items-center gap-1 px-2 py-1 rounded-lg',
    'bg-[color:var(--action-button-bg)] dark:bg-[color:var(--action-button-bg-dark)]',
    'text-[color:var(--action-button-text)] dark:text-[color:var(--action-button-text-dark)]',
    'hover:bg-[color:var(--action-button-hover-bg)] dark:hover:bg-[color:var(--action-button-hover-bg-dark)]',
    'transition-all duration-200',
    'icon-btn-bounce cursor-pointer'
  );

  const attachmentWrapperClasses = cx(
    'mt-3 flex flex-wrap gap-3',
    message.role === 'assistant' ? 'justify-start' : 'justify-end'
  );

  // Format message timestamp (use message timestamp if available, otherwise omit)
  const formattedTime = useMemo(() => {
    const timestamp = (message as any).timestamp || (message as any).createdAt;
    if (!timestamp) return null;
    try {
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) return null;
      const now = new Date();
      const isToday = date.toDateString() === now.toDateString();
      if (isToday) {
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      }
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
        ' ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return null;
    }
  }, [message]);

  return (
    <div className={wrapperClasses}>
      <div className={rowClasses} style={{ overflowWrap: 'anywhere' }}>
        <div className={avatarWrapperClasses}>
          {isAssistantMessage ? <BotAvatar src={'favicon.png'} height={24} width={24} /> : <IconUser size={24} className="text-gray-600 dark:text-gray-400" />}
        </div>

        <div className={cx('flex min-w-0 flex-1 flex-col', isAssistantMessage ? 'items-start' : 'items-end')}>
          {/* Deep Thinker mode badge for user messages - glass pill */}
          {message.role === 'user' && (message as any).metadata?.useDeepThinker && (
            <div className="mb-2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-nvidia-green/10 border border-nvidia-green/30 text-xs text-nvidia-green dark:bg-nvidia-green/15 dark:border-nvidia-green/40 backdrop-blur-sm animate-morph-in">
              <IconBrain size={14} />
              <span className="font-semibold">Deep Thinker</span>
            </div>
          )}
          <div className={bubbleClasses}>
            {/* Message time and status */}
            {message.role === 'user' && formattedTime && (
              <div className="flex items-center gap-1 justify-end mt-1 text-[10px] text-gray-500 dark:text-gray-400">
                <IconClock size={10} className="opacity-60" />
                <span>{formattedTime}</span>
              </div>
            )}
            {safeMessage.role === 'user' ? (
              <div className={cx(
                markdownBaseClasses,
                '[&_a]:!text-nvidia-green [&_a]:!font-semibold [&_a]:underline [&_a]:underline-offset-2',
                '[&_a:hover]:!text-nvidia-green/80',
                '[&_code]:!bg-white/10 [&_code]:!font-mono',
              )}>
                {(() => {
                  const { main, extracted } = splitExtractedBlock(messageContent);
                  return (
                    <>
                      <ReactMarkdown
                        className="prose dark:prose-invert"
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex] as any}
                        linkTarget="_blank"
                        components={getReactMarkDownCustomComponents(messageIndex, safeMessage.id)}
                      >
                        {prepareContent({ message: { ...safeMessage, content: main }, role: 'user' })}
                      </ReactMarkdown>

                      {extracted && (
                        <details className="mt-3 rounded-xl border border-nvidia-green/20 bg-nvidia-green/5 px-3 py-2 backdrop-blur-sm">
                          <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-200">
                            Extracted Document Text
                          </summary>
                          <div className="mt-3 text-gray-600 dark:text-gray-300 text-sm max-h-[400px] overflow-y-auto">
                            <ReactMarkdown
                              className="prose dark:prose-invert prose-sm"
                              remarkPlugins={[remarkGfm, remarkMath]}
                              rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex] as any}
                              linkTarget="_blank"
                              components={getReactMarkDownCustomComponents(messageIndex, safeMessage.id)}
                            >
                              {normalizeLatexDelimiters(extracted)}
                            </ReactMarkdown>
                          </div>
                        </details>
                      )}
                    </>
                  );
                })()}
                {message.attachments && message.attachments.length > 0 && (
                  <div className={attachmentWrapperClasses}>
                    {message.attachments.map((attachment, idx) => {
                      // Handle single image
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
                      // Handle multiple images
                      if (attachment.type === 'image' && attachment.imageRefs && attachment.imageRefs.length > 0) {
                        return (
                          <div key={idx}>
                            <ImageGallery images={attachment.imageRefs} />
                          </div>
                        );
                      }
                      // Handle single video
                      if (attachment.type === 'video' && attachment.videoRef) {
                        return (
                          <div key={idx} className="max-w-[320px] sm:max-w-md">
                            <video
                              src={getVideoUrl(attachment.videoRef)}
                              controls
                              controlsList="nodownload"
                              className="rounded-lg shadow-sm border border-white/10"
                              preload="metadata"
                            >
                              Your browser does not support the video tag.
                            </video>
                            {attachment.videoRef.filename && (
                              <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-500 dark:text-gray-400">
                                <IconVideo size={12} />
                                <span className="truncate">{attachment.videoRef.filename}</span>
                              </div>
                            )}
                          </div>
                        );
                      }
                      // Handle multiple videos
                      if (attachment.type === 'video' && attachment.videoRefs && attachment.videoRefs.length > 0) {
                        return (
                          <div key={idx} className="flex flex-col gap-3">
                            {attachment.videoRefs.map((vidRef, vidIdx) => (
                              <div key={vidIdx} className="max-w-[320px] sm:max-w-md">
                                <video
                                  src={getVideoUrl(vidRef)}
                                  controls
                                  className="rounded-lg shadow-sm border border-white/10"
                                  preload="metadata"
                                >
                                  Your browser does not support the video tag.
                                </video>
                                {vidRef.filename && (
                                  <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-500 dark:text-gray-400">
                                    <IconVideo size={12} />
                                    <span className="truncate">{vidRef.filename}</span>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        );
                      }
                      // Handle document
                      if (attachment.type === 'document' && attachment.documentRef) {
                        return (
                          <DocumentBadge
                            key={idx}
                            filename={attachment.documentRef.filename || 'Document'}
                            mimeType={attachment.documentRef.mimeType}
                          />
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

                {(() => {
                  const { main, extracted } = splitExtractedBlock(messageContent);
                  return (
                    <>
                      <MemoizedReactMarkdown
                        key={`msg-${safeMessage.id}-${messageContent.includes('/api/session/imageStorage') ? 'stored' : 'raw'}`}
                        className={markdownBaseClasses}
                        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex] as any}
                        remarkPlugins={[
                          remarkGfm,
                          [remarkMath, { singleDollarTextMath: false }],
                        ]}
                        linkTarget="_blank"
                        components={getReactMarkDownCustomComponents(messageIndex, safeMessage.id)}
                      >
                        {prepareContent({
                          message: { ...safeMessage, content: main },
                          role: 'assistant',
                          intermediateStepsContent: false,
                          responseContent: true,
                        })}
                      </MemoizedReactMarkdown>

                      {extracted && (
                        <details className="rounded-xl border border-[color:var(--surface-glass-border)] dark:border-[color:var(--surface-glass-border-strong)] bg-white/40 dark:bg-neutral-900/20 px-3 py-2">
                          <summary className="cursor-pointer text-sm font-medium text-neutral-700 dark:text-neutral-200">
                            Extracted document text
                          </summary>
                          <div className="mt-3">
                            <MemoizedReactMarkdown
                              className={markdownBaseClasses}
                              rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex] as any}
                              remarkPlugins={[
                                remarkGfm,
                                [remarkMath, { singleDollarTextMath: false }],
                              ]}
                              linkTarget="_blank"
                              components={getReactMarkDownCustomComponents(messageIndex, safeMessage.id)}
                            >
                              {normalizeLatexDelimiters(extracted)}
                            </MemoizedReactMarkdown>
                          </div>
                        </details>
                      )}
                    </>
                  );
                })()}

              </div>
            )}
          </div>

          {/* Inline error display for failed/partial responses */}
          {isAssistantMessage && hasError && (
            <div className="mt-2">
              <ErrorRecovery
                error={categorizeError(message.errorMessages!.message)}
                compact={hasPrimaryContent}
                isPartialResult={hasPrimaryContent}
                onRetry={onRetry}
              />
            </div>
          )}

          {!resolvedIsStreaming && copyText && (
            <div className={actionBarClasses}>
              <button
                className={classNames(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium',
                  'bg-[color:var(--action-button-bg)] dark:bg-[color:var(--action-button-bg-dark)] text-neutral-700 dark:text-neutral-200',
                  'backdrop-blur-md border border-[color:var(--surface-glass-border)] dark:border-[color:var(--surface-glass-border-strong)]',
                  'hover:bg-[color:var(--action-button-hover-bg)] dark:hover:bg-[color:var(--action-button-hover-bg-dark)]',
                  'hover:shadow-lg dark:hover:shadow-neutral-900/50',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/50',
                  'icon-btn-bounce' // Enhanced bounce animation on hover
                )}
                onClick={copyOnClick}
                aria-label="Copy message"
                id={message?.id}
              >
                {messagedCopied ? (
                  <IconCheck size={16} className="text-nvidia-green" />
                ) : (
                  <IconCopy size={16} />
                )}
                <span className="hidden sm:inline">Copy</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
ChatMessage.displayName = 'ChatMessage';
