'use client';

import React, { memo } from 'react';

import { extractStandaloneHtmlResponse } from '@/utils/app/htmlResponse';

import { LazyCodeBlock } from '@/components/markdown/LazyCodeBlock';
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';

export type ResponseContentKind = 'markdown' | 'html';

export interface ClassifiedResponseContent {
  kind: ResponseContentKind;
  content: string;
}

export const RESPONSE_PROSE_CLASSES =
  'prose dark:prose-invert prose-sm max-w-none break-words prose-p:my-1.5 prose-pre:my-2 prose-ul:my-1.5 prose-ol:my-1.5 prose-headings:text-dark-text-primary prose-a:text-nvidia-green prose-code:text-nvidia-green-light prose-strong:text-dark-text-primary';

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
   * Skips the raw-HTML rehype pass while tokens are still arriving. That pass
   * re-parses the whole document as HTML on every flush, and mid-stream markup
   * is usually half-formed anyway, so the work is discarded. The completed
   * answer renders through the full pipeline.
   */
  isStreaming?: boolean;
}

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

    return (
      <MarkdownRenderer
        content={document.content}
        messageIndex={messageIndex}
        messageId={messageId}
        className={className}
        allowHtml={!isStreaming}
      />
    );
  },
);

ResponseDocument.displayName = 'ResponseDocument';
