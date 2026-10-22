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
import {
  memo,
  useState,
  useRef,
  useEffect,
  useMemo,
  lazy,
  Suspense,
} from 'react';

import { isAutonomousFeedHtmlMessage } from '@/utils/app/htmlResponse';
import { parseMcpApprovalMarker } from '@/utils/app/mcpApproval';

import { Message } from '@/types/chat';

import type { ActivityProgress } from '@/components/agent/IntermediateSteps';
import { ToolbarSlotProvider } from '@/components/layout/ToolbarSlot';
import { Avatar, IconButton, Badge } from '@/components/primitives';
import { ModalSurface } from '@/components/surfaces';

import { McpApprovalCard } from './McpApprovalCard';
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

// Collapse only long answers, and only when doing so hides a substantial part.
const COLLAPSED_MAX_HEIGHT = 560; // px
const COLLAPSE_RENDERED_HEIGHT = COLLAPSED_MAX_HEIGHT + 280;

function formatGenerationDuration(milliseconds: number): string {
  if (milliseconds < 1000) return '<1s';
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

interface AssistantMessageProps {
  message: Message;
  messageIndex: number;
  isStreaming?: boolean;
  activityProgress?: ActivityProgress;
  onRetry?: () => void;
}

export const AssistantMessage = memo(
  ({
    message,
    messageIndex,
    isStreaming = false,
    activityProgress,
    onRetry,
  }: AssistantMessageProps) => {
    const [copied, setCopied] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [viewerToolbar, setViewerToolbar] = useState<HTMLElement | null>(
      null,
    );
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
    const mcpApproval = useMemo(
      () => parseMcpApprovalMarker(content),
      [content],
    );
    const errorMessages = message.errorMessages;
    const hasError = Boolean(errorMessages?.message);
    const isRecoverable = errorMessages?.recoverable === true;
    const durationMs = message.generationDurationMs;
    const showDuration =
      !isStreaming &&
      !hasError &&
      !mcpApproval &&
      Boolean(content) &&
      typeof durationMs === 'number' &&
      Number.isFinite(durationMs) &&
      durationMs >= 0 &&
      !((hasSteps || message.metadata?.stopped) && enableIntermediateSteps);
    // classifyResponseContent returns a fresh object literal, so without this
    // ResponseDocument's shallow memo never bails and re-renders per token.
    const responseDocument = useMemo(
      () =>
        classifyResponseContent(content, !isStreaming && !isAutonomousFeedHtml),
      [content, isStreaming, isAutonomousFeedHtml],
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
    const isHtmlDocument = !isStreaming && responseDocument.kind === 'html';
    // The icon matches the commands beside it in size and colour.
    const fullscreenButton = (iconSize: number) => (
      <button
        type="button"
        onClick={() => setIsFullscreen(true)}
        className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-lg text-primary transition-colors hover:bg-fill/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:h-9 md:w-9"
        aria-label="View fullscreen"
      >
        <IconMaximize size={iconSize} />
      </button>
    );

    return (
      <div className="chat-message group flex w-full gap-3 animate-morph-in">
        {/* Compact widths give the response the space, as in a 1:1 thread. */}
        <Avatar
          role={isAgent ? 'agent' : 'assistant'}
          size="sm"
          className="mt-1 hidden flex-shrink-0 md:flex"
        />

        <div className="flex w-full min-w-0 flex-1 flex-col">
          {/* Role badge */}
          {isAgent && (
            <Badge variant="primary" size="xs" className="self-start mb-1">
              Agent
            </Badge>
          )}

          {/* Error banner */}
          {hasError && !isStreaming && (
            <div
              role="alert"
              className={classNames(
                'mb-2 flex items-center gap-2 px-3 py-2 rounded-xl rounded-tl-lg',
                'bg-error/10 border border-error text-sm text-dark-text-primary',
              )}
            >
              <IconAlertCircle
                size={16}
                className="flex-shrink-0 text-primary"
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium">{errorMessages!.message}</div>
                {errorMessages!.category &&
                  errorMessages!.category !== 'unknown' && (
                    <div className="text-[0.75rem] text-dark-text-muted mt-0.5">
                      {errorMessages!.category.charAt(0).toUpperCase() +
                        errorMessages!.category.slice(1).replace(/_/g, ' ')}
                    </div>
                  )}
              </div>
              {isRecoverable && onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-primary hover:bg-error/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <IconRefresh size={12} />
                  Retry
                </button>
              )}
            </div>
          )}

          {/* Message content */}
          {mcpApproval && !isStreaming ? (
            <McpApprovalCard
              approval={mcpApproval}
              jobId={
                typeof message.metadata?.jobId === 'string'
                  ? message.metadata.jobId
                  : undefined
              }
            />
          ) : (
            content && (
              <div className="relative w-full min-w-0">
                <div
                  aria-busy={isStreaming}
                  className={classNames(
                    'min-w-0 text-dark-text-primary text-sm',
                    isAutonomousFeedHtml
                      ? 'p-0'
                      : [
                          'px-5 py-4 rounded-3xl',
                          'chat-bubble-assistant bg-chat-assistant border border-separator',
                        ],
                    isStreaming && 'border-nvidia-green/20',
                  )}
                >
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
                        isStreaming={isStreaming}
                        className={
                          isAutonomousFeedHtml
                            ? feedClasses
                            : RESPONSE_PROSE_CLASSES
                        }
                        documentActions={
                          isHtmlDocument ? fullscreenButton(18) : undefined
                        }
                      />
                    )}

                    {isStreaming && (
                      <span className="inline-block w-0.5 h-4 ml-0.5 bg-action animate-blink align-text-bottom" />
                    )}

                    {/* Keep the fade inside the clipped content, above the toggle. */}
                    {needsCollapse && !isExpanded && !isStreaming && (
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute bottom-0 inset-x-0 h-8 bg-gradient-to-t from-chat-assistant to-transparent"
                      />
                    )}
                  </div>

                  {/* Expand/collapse toggle */}
                  {needsCollapse && !isStreaming && (
                    <div className="mt-2 flex items-center gap-2 border-t border-separator/70 pt-2">
                      <button
                        type="button"
                        onClick={() => setIsExpanded(!isExpanded)}
                        aria-expanded={isExpanded}
                        className="flex min-h-11 flex-1 items-center gap-1.5 text-xs font-medium text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:min-h-9"
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
                      {fullscreenButton(14)}
                    </div>
                  )}
                </div>

                {/* Actions. Touch shows them below the response at all times; a
                    pointer reveals them over the bubble's top corner on hover
                    or focus, so they reserve no space between messages. */}
                {!isStreaming && content && (
                  <div
                    data-side="end"
                    className="message-actions touch-action-controls mt-1 flex items-center gap-1"
                  >
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
            )
          )}
          {!mcpApproval &&
            !isAutonomousFeedHtml &&
            (isStreaming ||
              ((hasSteps || message.metadata?.stopped) &&
                enableIntermediateSteps)) && (
              <Suspense fallback={<div className="h-11 md:h-8" />}>
                <IntermediateSteps
                  steps={
                    enableIntermediateSteps
                      ? message.intermediateSteps || []
                      : []
                  }
                  isStreaming={isStreaming}
                  durationMs={durationMs}
                  hasError={hasError}
                  stopped={message.metadata?.stopped === true}
                  progress={activityProgress}
                />
              </Suspense>
            )}
          {showDuration && (
            <small
              className="mt-1 px-1 text-xs text-secondary tabular-nums"
              title="Total elapsed time, including agent and tool work"
            >
              Generated in {formatGenerationDuration(durationMs!)}
            </small>
          )}
        </div>

        {/* Fullscreen document viewer. One toolbar names the document and
            holds every command, as the window toolbar does; an HTML
            document's own commands join it through the toolbar slot. */}
        <ModalSurface
          open={isFullscreen}
          onClose={() => setIsFullscreen(false)}
          position="fullscreen"
          aria-label="Response document"
          className="flex h-full w-full flex-col bg-dark-bg-primary"
          backdropClassName="bg-dark-bg-primary/95"
        >
          <div
            data-kind={responseDocument.kind}
            className="document-viewer-toolbar relative z-10 flex flex-shrink-0 items-center"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 pl-2 text-sm font-medium text-dark-text-primary">
              <IconFileText
                size={16}
                className="flex-shrink-0 text-nvidia-green"
              />
              <span className="truncate">
                {responseDocument.kind === 'html'
                  ? 'HTML Document'
                  : 'Document View'}
              </span>
            </div>
            <div ref={setViewerToolbar} className="contents" />
            {responseDocument.kind !== 'html' && (
              <IconButton
                icon={copied ? <IconCheck /> : <IconCopy />}
                aria-label="Copy content"
                variant="ghost"
                className="app-chrome app-toolbar-button"
                onClick={handleCopy}
              />
            )}
            <IconButton
              icon={<IconMinimize />}
              aria-label="Close fullscreen"
              variant="ghost"
              className="app-chrome app-toolbar-button"
              onClick={() => setIsFullscreen(false)}
            />
          </div>

          <ToolbarSlotProvider value={viewerToolbar}>
            <div
              className={classNames(
                'min-h-0 flex-1',
                responseDocument.kind === 'html'
                  ? 'document-viewer-body'
                  : 'safe-bottom overflow-y-auto px-4 py-5 md:px-12 md:py-6 lg:px-24',
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
          </ToolbarSlotProvider>
        </ModalSurface>
      </div>
    );
  },
);

AssistantMessage.displayName = 'AssistantMessage';
