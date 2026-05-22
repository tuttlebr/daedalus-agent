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

import { extractStandaloneHtmlResponse } from '@/utils/app/htmlResponse';

import { Message } from '@/types/chat';

import { LazyCodeBlock } from '@/components/markdown/LazyCodeBlock';
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';
import { Avatar, IconButton, Badge } from '@/components/primitives';

import { useUISettingsStore } from '@/state';
import classNames from 'classnames';

const IntermediateSteps = lazy(() =>
  import('@/components/agent/IntermediateSteps').then((m) => ({
    default: m.IntermediateSteps,
  })),
);

// Threshold: messages longer than this get the collapsible treatment
const LONG_CONTENT_CHARS = 1500;
const COLLAPSED_MAX_HEIGHT = 300; // px

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
    const isLongContent = content.length > LONG_CONTENT_CHARS;
    const errorMessages = message.errorMessages;
    const hasError = Boolean(errorMessages?.message);
    const isRecoverable = errorMessages?.recoverable === true;
    const htmlPreviewContent = !isStreaming
      ? extractStandaloneHtmlResponse(content)
      : null;

    // After render, check if the actual rendered height exceeds the threshold
    useEffect(() => {
      if (!isStreaming && contentRef.current && isLongContent) {
        setNeedsCollapse(
          contentRef.current.scrollHeight > COLLAPSED_MAX_HEIGHT + 50,
        );
      }
    }, [content, isStreaming, isLongContent]);

    const handleCopy = () => {
      navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    const proseClasses =
      'prose dark:prose-invert prose-sm max-w-none prose-p:my-1.5 prose-pre:my-2 prose-ul:my-1.5 prose-ol:my-1.5 prose-headings:text-dark-text-primary prose-a:text-nvidia-green prose-code:text-nvidia-green-light prose-strong:text-dark-text-primary';

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
          {hasSteps && enableIntermediateSteps && (
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
                className={classNames(
                  'min-w-0 px-4 py-3 rounded-2xl rounded-tl-lg',
                  'bg-dark-bg-secondary/80 border border-white/[0.06]',
                  'text-dark-text-primary text-sm',
                  isStreaming && 'border-nvidia-green/20',
                )}
              >
                {/* Long content header with document icon */}
                {needsCollapse && !isStreaming && (
                  <div className="flex items-center justify-between mb-2 pb-2 border-b border-white/[0.06]">
                    <div className="flex min-w-0 items-center gap-2 text-xs text-dark-text-muted">
                      <IconFileText size={14} className="text-nvidia-green" />
                      <span className="truncate">
                        Long response ({Math.ceil(content.length / 1000)}k
                        chars)
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setIsFullscreen(true)}
                        className="p-1 rounded text-dark-text-muted hover:text-dark-text-primary hover:bg-white/[0.04] transition-colors"
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
                  {htmlPreviewContent ? (
                    <LazyCodeBlock
                      language="html"
                      value={htmlPreviewContent}
                      defaultPreview
                    />
                  ) : (
                    content && (
                      <MarkdownRenderer
                        content={content}
                        messageIndex={messageIndex}
                        messageId={message.id}
                        className={proseClasses}
                      />
                    )
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

              {/* Action buttons */}
              {!isStreaming && content && (
                <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <IconButton
                    icon={copied ? <IconCheck /> : <IconCopy />}
                    aria-label="Copy message"
                    variant="ghost"
                    size="xs"
                    onClick={handleCopy}
                  />
                  {onRetry && (
                    <IconButton
                      icon={<IconRefresh />}
                      aria-label="Regenerate response"
                      variant="ghost"
                      size="xs"
                      onClick={onRetry}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Fullscreen document viewer */}
        {isFullscreen && (
          <div className="fixed inset-0 z-[200] bg-dark-bg-primary/95 backdrop-blur-xl flex flex-col">
            {/* Toolbar */}
            <div className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-b border-white/[0.06]">
              <div className="flex items-center gap-2 text-sm text-dark-text-muted">
                <IconFileText size={16} className="text-nvidia-green" />
                <span>Document View</span>
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

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto px-6 py-6 md:px-12 lg:px-24">
              <div className="max-w-4xl mx-auto">
                <MarkdownRenderer
                  content={content}
                  messageIndex={messageIndex}
                  messageId={message.id}
                  className={classNames(proseClasses, 'prose-base')}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    );
  },
);

AssistantMessage.displayName = 'AssistantMessage';
