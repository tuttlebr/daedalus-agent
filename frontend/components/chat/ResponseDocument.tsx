'use client';

import React, { Fragment, memo, useMemo } from 'react';

import { extractStandaloneHtmlResponse } from '@/utils/app/htmlResponse';
import { splitStreamingMarkdown } from '@/utils/app/streamingMarkdown';

import { LazyCodeBlock } from '@/components/markdown/LazyCodeBlock';
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';

export type ResponseContentKind = 'markdown' | 'html';

export interface ClassifiedResponseContent {
  kind: ResponseContentKind;
  content: string;
}

export const RESPONSE_PROSE_CLASSES =
  'prose dark:prose-invert prose-sm max-w-none break-words leading-relaxed prose-p:my-2 prose-pre:my-3 prose-ul:my-2 prose-ol:my-2 prose-headings:text-dark-text-primary prose-a:text-nvidia-green prose-code:text-nvidia-green-light prose-strong:text-dark-text-primary';

export function classifyResponseContent(
  content: string,
  allowStandaloneHtml = true,
): ClassifiedResponseContent {
  const html = allowStandaloneHtml
    ? extractStandaloneHtmlResponse(content)
    : null;
  return html ? { kind: 'html', content: html } : { kind: 'markdown', content };
}

interface ResponseDocumentProps {
  document: ClassifiedResponseContent;
  messageIndex: number;
  messageId?: string;
  className?: string;
  fullscreen?: boolean;
  /**
   * While tokens are still arriving, completed top-level blocks keep their
   * rendered output and only the growing tail is parsed again, and the
   * raw-HTML rehype pass is skipped (mid-stream markup is usually half-formed
   * anyway). The completed answer renders through the full pipeline.
   */
  isStreaming?: boolean;
}

interface StreamingMarkdownProps {
  content: string;
  messageIndex: number;
  messageId?: string;
  className: string;
}

/**
 * Renders a streaming answer block by block. Each block renders the same alone
 * as within the whole text (see splitStreamingMarkdown), and the newline
 * between them is the separator the whole-document render places between
 * top-level elements, so the markup matches a single render. Unchanged blocks
 * skip rendering through MarkdownRenderer's memo.
 */
const StreamingMarkdown = memo(
  ({ content, messageIndex, messageId, className }: StreamingMarkdownProps) => {
    const blocks = useMemo(() => splitStreamingMarkdown(content), [content]);
    return (
      <div className={className}>
        {blocks.map((block, index) => (
          <Fragment key={index}>
            {index > 0 ? '\n' : null}
            <MarkdownRenderer
              content={block}
              messageIndex={messageIndex}
              messageId={messageId}
              className=""
              allowHtml={false}
            />
          </Fragment>
        ))}
      </div>
    );
  },
);

StreamingMarkdown.displayName = 'StreamingMarkdown';

/** Uses the same content classification and renderer in inline and fullscreen. */
export const ResponseDocument = memo(
  ({
    document,
    messageIndex,
    messageId,
    className = RESPONSE_PROSE_CLASSES,
    fullscreen = false,
    isStreaming = false,
  }: ResponseDocumentProps) => {
    if (document.kind === 'html') {
      return (
        <LazyCodeBlock
          language="html"
          value={document.content}
          defaultPreview
          fullscreen={fullscreen}
        />
      );
    }

    if (isStreaming) {
      return (
        <StreamingMarkdown
          content={document.content}
          messageIndex={messageIndex}
          messageId={messageId}
          className={className}
        />
      );
    }

    return (
      <MarkdownRenderer
        content={document.content}
        messageIndex={messageIndex}
        messageId={messageId}
        className={className}
      />
    );
  },
);

ResponseDocument.displayName = 'ResponseDocument';
