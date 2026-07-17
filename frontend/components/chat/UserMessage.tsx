'use client';

import {
  IconCopy,
  IconCheck,
  IconNotes,
  IconFileText,
  IconChevronDown,
  IconChevronUp,
} from '@tabler/icons-react';
import { memo, useMemo, useState } from 'react';

import { Message } from '@/types/chat';

import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';
import { Avatar, Badge, IconButton } from '@/components/primitives';

import classNames from 'classnames';

type Attachment = NonNullable<Message['attachments']>[number];

interface InlineDocument {
  filename: string;
  pages: number;
  truncated: boolean;
  originalChars: number;
  markdown: string;
}

const ATTACHED_DOC_RE =
  /<attached_document\s+([^>]*)>([\s\S]*?)<\/attached_document>/g;

function getAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`);
  const match = attrs.match(re);
  return match ? match[1] : undefined;
}

function decodeXmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseInlineDocuments(raw: string): {
  cleanedContent: string;
  inlineDocs: InlineDocument[];
} {
  const inlineDocs: InlineDocument[] = [];
  let cleanedContent = raw.replace(ATTACHED_DOC_RE, (_match, attrs, body) => {
    const filename = decodeXmlAttr(getAttr(attrs, 'filename') || 'document');
    const pages = parseInt(getAttr(attrs, 'pages') || '0', 10) || 0;
    const truncated = getAttr(attrs, 'truncated') === 'true';
    const originalChars =
      parseInt(getAttr(attrs, 'original_chars') || '0', 10) || 0;
    inlineDocs.push({
      filename,
      pages,
      truncated,
      originalChars,
      markdown: body.trim(),
    });
    return '';
  });
  // Collapse any whitespace runs the strip leaves behind.
  cleanedContent = cleanedContent.replace(/\n{3,}/g, '\n\n').trim();
  return { cleanedContent, inlineDocs };
}

interface UserMessageProps {
  message: Message;
  messageIndex: number;
}

export const UserMessage = memo(
  ({ message, messageIndex }: UserMessageProps) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
      navigator.clipboard.writeText(message.content || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    const rawContent =
      typeof message.content === 'string' ? message.content : '';
    const { cleanedContent: content, inlineDocs } = useMemo(
      () => parseInlineDocuments(rawContent),
      [rawContent],
    );
    const attachments = message.attachments || [];

    return (
      <div className="group flex w-full justify-end gap-3 animate-morph-in">
        <div className="flex max-w-[85%] min-w-0 flex-col items-end md:max-w-2xl">
          {/* Attachments above bubble */}
          {attachments.length > 0 && (
            <div className="flex max-w-full flex-wrap gap-2 mb-2 justify-end">
              {attachments.map((att, i) => (
                <AttachmentDisplay key={i} attachment={att} />
              ))}
            </div>
          )}

          {/* Inline-extracted document cards (one per <attached_document>) */}
          {inlineDocs.length > 0 && (
            <div className="w-full mb-2 space-y-2">
              {inlineDocs.map((doc, i) => (
                <InlineDocumentCard
                  key={`${doc.filename}-${i}`}
                  doc={doc}
                  messageIndex={messageIndex}
                />
              ))}
            </div>
          )}

          {/* Message bubble */}
          {content && (
            <div className="relative max-w-full">
              <div
                className={classNames(
                  'min-w-0 px-4 py-3 rounded-2xl rounded-br-lg',
                  'bg-nvidia-green/10 border border-nvidia-green/20',
                  'text-dark-text-primary text-sm',
                )}
              >
                <MarkdownRenderer
                  content={content}
                  messageIndex={messageIndex}
                  className="prose dark:prose-invert prose-sm max-w-none break-words prose-p:my-1"
                />
              </div>

              {/* Copy button — below the bubble so it never clips off-screen;
                  always visible on touch, hover-only on desktop */}
              <div className="mt-1 flex justify-end opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                <IconButton
                  icon={copied ? <IconCheck /> : <IconCopy />}
                  aria-label="Copy message"
                  variant="ghost"
                  size="sm"
                  onClick={handleCopy}
                />
              </div>
            </div>
          )}
        </div>

        <Avatar role="user" size="sm" className="flex-shrink-0 mt-1" />
      </div>
    );
  },
);

UserMessage.displayName = 'UserMessage';

const AttachmentDisplay = memo(({ attachment }: { attachment: Attachment }) => {
  if (attachment.type === 'image' && attachment.imageRef) {
    return (
      <div className="w-32 h-32 rounded-lg overflow-hidden bg-dark-bg-tertiary border border-white/5">
        <img
          src={`/api/session/imageStorage?imageId=${attachment.imageRef.imageId}&thumbnail=true`}
          alt="Attached image"
          className="w-full h-full object-cover"
          loading="lazy"
        />
      </div>
    );
  }

  if (attachment.type === 'document' && attachment.documentRef) {
    return (
      <div className="px-3 py-2 rounded-lg bg-dark-bg-tertiary border border-white/5 text-xs text-dark-text-muted">
        {attachment.content || 'Document'}
      </div>
    );
  }

  if (attachment.type === 'video' && attachment.videoRef) {
    return (
      <div className="px-3 py-2 rounded-lg bg-dark-bg-tertiary border border-white/5 text-xs text-dark-text-muted">
        Video: {attachment.content || 'Attached'}
      </div>
    );
  }

  if (attachment.type === 'transcript' && attachment.vttRef) {
    return (
      <div className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-dark-bg-tertiary border border-nvidia-yellow/20 text-xs text-nvidia-yellow">
        <IconNotes size={14} />
        <span>{attachment.content || 'Transcript'}</span>
      </div>
    );
  }

  return null;
});

AttachmentDisplay.displayName = 'AttachmentDisplay';

interface InlineDocumentCardProps {
  doc: InlineDocument;
  messageIndex: number;
}

const InlineDocumentCard = memo(
  ({ doc, messageIndex }: InlineDocumentCardProps) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const charsLabel = `${doc.markdown.length.toLocaleString()} chars`;
    const pageLabel = doc.pages > 0 ? `${doc.pages} pages` : null;
    const omitted = doc.truncated
      ? Math.max(0, doc.originalChars - doc.markdown.length)
      : 0;

    return (
      <div className="w-full rounded-2xl rounded-br-lg border border-nvidia-blue/25 bg-dark-bg-secondary/60 overflow-hidden">
        <button
          type="button"
          onClick={() => setIsExpanded((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-blue/40"
          aria-expanded={isExpanded}
        >
          <IconFileText
            size={14}
            className="flex-shrink-0 text-nvidia-blue"
            aria-hidden
          />
          <span className="truncate text-xs font-medium text-dark-text-primary">
            {doc.filename}
          </span>
          <span className="text-[11px] text-dark-text-muted whitespace-nowrap">
            inline · {[pageLabel, charsLabel].filter(Boolean).join(' · ')}
          </span>
          {doc.truncated && (
            <Badge variant="warning" size="xs" className="whitespace-nowrap">
              Truncated · {omitted.toLocaleString()} chars omitted
            </Badge>
          )}
          <span className="ml-auto flex-shrink-0 text-dark-text-muted">
            {isExpanded ? (
              <IconChevronUp size={14} />
            ) : (
              <IconChevronDown size={14} />
            )}
          </span>
        </button>
        {isExpanded && (
          <div className="border-t border-white/[0.06] bg-dark-bg-tertiary/40 px-4 py-3">
            <div className="max-h-[300px] overflow-y-auto pr-1">
              <MarkdownRenderer
                content={doc.markdown}
                messageIndex={messageIndex}
                className="prose dark:prose-invert prose-sm max-w-none prose-p:my-1.5 prose-pre:my-2 prose-headings:text-dark-text-primary"
              />
            </div>
          </div>
        )}
      </div>
    );
  },
);

InlineDocumentCard.displayName = 'InlineDocumentCard';
