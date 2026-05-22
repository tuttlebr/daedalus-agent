'use client';

import { IconCopy, IconCheck, IconNotes } from '@tabler/icons-react';
import { memo, useState } from 'react';

import { Message } from '@/types/chat';

import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';
import { Avatar, IconButton } from '@/components/primitives';

import classNames from 'classnames';

type Attachment = NonNullable<Message['attachments']>[number];

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

    const content = typeof message.content === 'string' ? message.content : '';
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
                  className="prose dark:prose-invert prose-sm max-w-none prose-p:my-1"
                />
              </div>

              {/* Copy button */}
              <div className="absolute -bottom-1 -left-8 opacity-0 group-hover:opacity-100 transition-opacity">
                <IconButton
                  icon={copied ? <IconCheck /> : <IconCopy />}
                  aria-label="Copy message"
                  variant="ghost"
                  size="xs"
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
