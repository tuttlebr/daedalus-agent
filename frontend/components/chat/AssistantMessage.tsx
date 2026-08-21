'use client';

import {
  IconCopy,
  IconCheck,
  IconRefresh,
  IconChevronDown,
  IconChevronUp,
  IconFileText,
  IconMaximize,
  IconMinimize,
  IconAlertCircle,
} from '@tabler/icons-react';
import { memo, useState, useRef, useEffect, lazy, Suspense } from 'react';

import { isAutonomousFeedHtmlMessage } from '@/utils/app/htmlResponse';

import { Message } from '@/types/chat';

import { Avatar, IconButton, Badge } from '@/components/primitives';
import { ModalSurface } from '@/components/surfaces';

import {
  classifyResponseContent,
  ResponseDocument,
  RESPONSE_PROSE_CLASSES,
} from './ResponseDocument';

import { useUISettingsStore } from '@/state';
import classNames from 'classnames';

const IntermediateSteps = lazy(() =>
  import('@/components/agent/IntermediateSteps').then((m) => ({
    default: m.IntermediateSteps,
  })),
);

const COLLAPSED_MAX_HEIGHT = 300; // px
const COLLAPSE_RENDERED_HEIGHT = COLLAPSED_MAX_HEIGHT + 50;

interface AssistantMessageProps {
  message: Message;
  messageIndex: number;
  isStreaming?: boolean;
  onRetry?: () => void;
}

export const AssistantMessage = memo(
  ({
    message,
    messageIndex,
    isStreaming = false,
    onRetry,
  }: AssistantMessageProps) => {
    const [copied, setCopied] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [needsCollapse, setNeedsCollapse] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);
    const enableIntermediateSteps = useUISettingsStore(
      (s) => s.enableIntermediateSteps,
    );

    const content = typeof message.content === 'string' ? message.content : '';
    const hasSteps =
      message.intermediateSteps && message.intermediateSteps.length > 0;
    const isAgent = message.role === 'agent';
    const isAutonomousFeedHtml = isAutonomousFeedHtmlMessage(message);
    const errorMessages = message.errorMessages;
    const hasError = Boolean(errorMessages?.message);
    const isRecoverable = errorMessages?.recoverable === true;
    const responseDocument = classifyResponseContent(
      content,
      !isStreaming && !isAutonomousFeedHtml,
    );

    // After render, check if the actual rendered height exceeds the threshold
    useEffect(() => {
      if (isStreaming || !contentRef.current || isAutonomousFeedHtml) {
        setNeedsCollapse(false);
        return;
      }

      const element = contentRef.current;
      const measure = () => {
        setNeedsCollapse(
          responseDocument.kind === 'markdown' &&
            element.scrollHeight > COLLAPSE_RENDERED_HEIGHT,
        );
      };
      measure();

      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }, [content, isStreaming, isAutonomousFeedHtml, responseDocument.kind]);

    const handleCopy = () => {
      navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    const feedClasses = 'autonomous-feed-render max-w-none';
    const showDocumentHeader =
      !isStreaming && (needsCollapse || responseDocument.kind === 'html');

    return (
      <div className="group flex w-full gap-3 animate-morph-in">
        <Avatar
          role={isAgent ? 'agent' : 'assistant'}
          size="sm"
          className="flex-shrink-0 mt-1"
        />

        <div className="flex w-full min-w-0 flex-1 flex-col">
          {/* Role badge */}
          {isAgent && (
            <Badge variant="primary" size="xs" className="self-start mb-1">
              Agent
            </Badge>
          )}

          {/* Intermediate steps */}
          {hasSteps && enableIntermediateSteps && !isStreaming && (
            <Suspense
              fallback={
                <div className="h-8 bg-white/[0.02] rounded-lg animate-pulse mb-2" />
              }
            >
              <div className="mb-2 w-full min-w-0">
                <IntermediateSteps steps={message.intermediateSteps!} />
              </div>
            </Suspense>
          )}

          {/* Error banner */}
          {hasError && !isStreaming && (
            <div
              role="alert"
              className={classNames(
                'mb-2 flex items-start gap-2 px-3 py-2 rounded-xl rounded-tl-lg',
                'bg-nvidia-red/10 border border-nvidia-red/30 text-sm text-dark-text-primary',
              )}
            >
              <IconAlertCircle
                size={16}
                className="mt-0.5 flex-shrink-0 text-nvidia-red"
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium">{errorMessages!.message}</div>
                {errorMessages!.category &&
                  errorMessages!.category !== 'unknown' && (
                    <div className="text-[10px] uppercase tracking-wider text-dark-text-muted mt-0.5">
                      {errorMessages!.category.replace('_', ' ')}
                    </div>
                  )}
              </div>
              {isRecoverable && onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-nvidia-red hover:bg-nvidia-red/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-red/40"
                >
                  <IconRefresh size={12} />
                  Retry
                </button>
              )}
            </div>
          )}

          {/* Message content */}
          {(content || isStreaming) && (
            <div className="relative w-full min-w-0">
              <div
                aria-busy={isStreaming}
                className={classNames(
                  'min-w-0 text-dark-text-primary text-sm',
                  isAutonomousFeedHtml
                    ? 'p-0'
                    : [
                        'px-4 py-3 rounded-2xl rounded-tl-lg',
                        'bg-dark-bg-secondary/80 border border-white/[0.06]',
                      ],
                  isStreaming && 'border-nvidia-green/20',
                )}
              >
                {/* Long content header with document icon */}
                {showDocumentHeader && (
                  <div className="flex items-center justify-between mb-2 pb-2 border-b border-white/[0.06]">
                    <div className="flex min-w-0 items-center gap-2 text-xs text-dark-text-muted">
                      <IconFileText size={14} className="text-nvidia-green" />
                      <span className="truncate">
                        {responseDocument.kind === 'html'
                          ? 'HTML preview'
                          : `Long response (${Math.ceil(
                              content.length / 1000,
                            )}k chars)`}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setIsFullscreen(true)}
                        className="grid h-11 w-11 place-items-center rounded-lg text-dark-text-muted transition-colors hover:bg-white/[0.04] hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40 md:h-9 md:w-9"
                        aria-label="View fullscreen"
                      >
                        <IconMaximize size={14} />
                      </button>
                    </div>
                  </div>
                )}

                {/* Collapsible content wrapper */}
                <div
                  ref={contentRef}
                  className={classNames(
                    'relative',
                    needsCollapse &&
                      !isExpanded &&
                      !isStreaming &&
                      'overflow-hidden',
                  )}
                  style={
                    needsCollapse && !isExpanded && !isStreaming
                      ? { maxHeight: COLLAPSED_MAX_HEIGHT }
                      : undefined
                  }
                >
                  {content && (
                    <ResponseDocument
                      document={responseDocument}
                      messageIndex={messageIndex}
                      messageId={message.id}
                      className={
                        isAutonomousFeedHtml
                          ? feedClasses
                          : RESPONSE_PROSE_CLASSES
                      }
                    />
                  )}

                  {isStreaming && (
                    <span className="inline-block w-0.5 h-4 ml-0.5 bg-nvidia-green animate-blink align-text-bottom" />
                  )}
                </div>

                {/* Gradient fade when collapsed */}
                {needsCollapse && !isExpanded && !isStreaming && (
                  <div className="absolute bottom-12 left-0 right-0 h-20 bg-gradient-to-t from-dark-bg-secondary/95 to-transparent pointer-events-none rounded-b-2xl" />
                )}

                {/* Expand/collapse toggle */}
                {needsCollapse && !isStreaming && (
                  <button
                    type="button"
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="flex items-center gap-1.5 w-full mt-2 pt-2 border-t border-white/[0.04] text-xs font-medium text-nvidia-green hover:text-nvidia-green-light transition-colors"
                  >
                    {isExpanded ? (
                      <>
                        <IconChevronUp size={14} />
                        <span>Show Less</span>
                      </>
                    ) : (
                      <>
                        <IconChevronDown size={14} />
                        <span>Show Full Response</span>
                      </>
                    )}
                  </button>
                )}
              </div>

              {/* Action buttons — always visible on touch, hover-only on desktop */}
              {!isStreaming && content && (
                <div className="flex items-center gap-1 mt-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                  <IconButton
                    icon={copied ? <IconCheck /> : <IconCopy />}
                    aria-label="Copy message"
                    variant="ghost"
                    size="sm"
                    onClick={handleCopy}
                  />
                  {onRetry && (
                    <IconButton
                      icon={<IconRefresh />}
                      aria-label="Regenerate response"
                      variant="ghost"
                      size="sm"
                      onClick={onRetry}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Fullscreen document viewer */}
        <ModalSurface
          open={isFullscreen}
          onClose={() => setIsFullscreen(false)}
          position="fullscreen"
          aria-label="Response document"
          className="flex h-full w-full flex-col bg-dark-bg-primary/95 backdrop-blur-xl"
          backdropClassName="bg-dark-bg-primary/95"
        >
          {/* Toolbar */}
          <div className="safe-top flex min-h-14 flex-shrink-0 items-center justify-between border-b border-white/[0.06] px-3 py-2 md:px-6">
            <div className="flex items-center gap-2 text-sm text-dark-text-muted">
              <IconFileText size={16} className="text-nvidia-green" />
              <span>
                {responseDocument.kind === 'html'
                  ? 'HTML document'
                  : 'Document view'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <IconButton
                icon={copied ? <IconCheck /> : <IconCopy />}
                aria-label="Copy content"
                variant="ghost"
                size="sm"
                onClick={handleCopy}
              />
              <IconButton
                icon={<IconMinimize />}
                aria-label="Close fullscreen"
                variant="ghost"
                size="sm"
                onClick={() => setIsFullscreen(false)}
              />
            </div>
          </div>

          <div
            className={classNames(
              'safe-bottom min-h-0 flex-1',
              responseDocument.kind === 'html'
                ? 'p-2 md:p-4'
                : 'overflow-y-auto px-4 py-5 md:px-12 md:py-6 lg:px-24',
            )}
          >
            <div
              className={classNames(
                responseDocument.kind === 'html'
                  ? 'h-full min-h-0 w-full'
                  : 'mx-auto max-w-4xl',
              )}
            >
              <ResponseDocument
                document={responseDocument}
                messageIndex={messageIndex}
                messageId={message.id}
                className={RESPONSE_PROSE_CLASSES}
                fullscreen
              />
            </div>
          </div>
        </ModalSurface>
      </div>
    );
  },
);

AssistantMessage.displayName = 'AssistantMessage';
