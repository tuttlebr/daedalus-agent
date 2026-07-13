'use client';

import {
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconMessage,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import React, { useEffect } from 'react';

import { getImageUrl } from '@/utils/app/imageHandler';
import { getImageOutputMimeType } from '@/utils/app/imageModelCapabilities';

import { OptimizedImage } from '@/components/chat/OptimizedImage';

import type { GalleryImage, ImageRef } from '@/state/imagePanelStore';
import classNames from 'classnames';

const GENERATED_SESSION_ID = 'generated';

function generatedRef(
  image: Pick<GalleryImage, 'imageId' | 'params'>,
): ImageRef {
  return {
    imageId: image.imageId,
    sessionId: GENERATED_SESSION_ID,
    mimeType: getImageOutputMimeType(image.params),
  };
}

interface OutputActionSheetProps {
  open: boolean;
  image: GalleryImage | null;
  onClose: () => void;
  onReuseAsInput: (ref: ImageRef) => void;
  onSendToChat?: (imageId: string) => void;
  onDelete: (imageId: string) => void;
}

/**
 * The compact output inspector used below the desktop-detail breakpoint.
 * A selected image has one stable place for all actions, rather than five
 * competing controls on every small canvas tile.
 */
export function OutputActionSheet({
  open,
  image,
  onClose,
  onReuseAsInput,
  onSendToChat,
  onDelete,
}: OutputActionSheetProps) {
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, open]);

  if (!open || !image) return null;

  const ref = generatedRef(image);
  const fullUrl = getImageUrl(ref, false);
  const downloadUrl = `${fullUrl}?download=1`;

  const reuse = () => {
    onReuseAsInput(ref);
    onClose();
  };
  const sendToChat = () => {
    onSendToChat?.(image.imageId);
    onClose();
  };
  const remove = () => {
    onDelete(image.imageId);
    onClose();
  };

  return (
    <div className="lg:hidden">
      <div
        className="fixed inset-0 z-[70] bg-black/65 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="selected-output-title"
        className="fixed inset-x-0 bottom-0 z-[71] max-h-[88dvh] overflow-y-auto rounded-t-3xl border-t border-white/10 bg-neutral-950/98 pb-safe-bottom shadow-2xl"
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-white/15" />
        <header className="flex items-center justify-between px-4 pb-3 pt-2">
          <div>
            <h2
              id="selected-output-title"
              className="text-base font-semibold text-neutral-100"
            >
              Selected image
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Choose what to do next
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close selected image actions"
            className="grid h-11 w-11 place-items-center rounded-full text-neutral-400 transition-colors hover:bg-white/5 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40"
          >
            <IconX size={20} />
          </button>
        </header>

        <div className="px-4 pb-4">
          <div className="overflow-hidden rounded-2xl bg-black/30 ring-1 ring-white/10">
            <OptimizedImage
              imageRef={ref}
              alt={image.prompt}
              useThumbnail
              showControls={false}
              enableFullscreen={false}
              className="h-48 w-full object-contain"
            />
          </div>

          <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-neutral-300">
            {image.prompt}
          </p>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <SheetAction
              icon={<IconEdit size={18} />}
              label="Continue editing"
              onClick={reuse}
              emphasis
            />
            <SheetAction
              icon={<IconDownload size={18} />}
              label="Download"
              href={downloadUrl}
            />
            <SheetAction
              icon={<IconExternalLink size={18} />}
              label="Open full size"
              onClick={() => window.open(fullUrl, '_blank', 'noopener')}
            />
            {onSendToChat && (
              <SheetAction
                icon={<IconMessage size={18} />}
                label="Send to chat"
                onClick={sendToChat}
              />
            )}
            <SheetAction
              icon={<IconTrash size={18} />}
              label="Remove from workspace"
              onClick={remove}
              destructive
              className={onSendToChat ? 'col-span-2' : ''}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function SheetAction({
  icon,
  label,
  onClick,
  href,
  emphasis = false,
  destructive = false,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  href?: string;
  emphasis?: boolean;
  destructive?: boolean;
  className?: string;
}) {
  const classes = classNames(
    'inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium transition-colors touch-manipulation focus-visible:outline-none focus-visible:ring-2',
    emphasis
      ? 'border-nvidia-green bg-nvidia-green text-black hover:bg-nvidia-green-dark focus-visible:ring-nvidia-green/50'
      : destructive
      ? 'border-red-500/25 text-red-300 hover:bg-red-500/10 focus-visible:ring-red-500/40'
      : 'border-white/10 bg-white/[0.04] text-neutral-200 hover:bg-white/[0.08] focus-visible:ring-nvidia-green/40',
    className,
  );

  if (href) {
    return (
      <a href={href} className={classes}>
        {icon}
        <span>{label}</span>
      </a>
    );
  }

  return (
    <button type="button" onClick={onClick} className={classes}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
