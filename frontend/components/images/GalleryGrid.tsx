'use client';

import React from 'react';
import classNames from 'classnames';
import {
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconMessage,
} from '@tabler/icons-react';
import { IconButton, Tooltip } from '@/components/primitives';
import { OptimizedImage } from '@/components/chat/OptimizedImage';
import { getImageUrl } from '@/utils/app/imageHandler';
import type { GalleryImage, ImageRef } from '@/state/imagePanelStore';

// Generated images live in Redis at `generated:image:{id}`. Passing
// `sessionId: 'generated'` routes getImageUrl() to /api/generated-image/{id}
// (see imageHandler.ts). The OptimizedImage component then handles
// IntersectionObserver lazy-loading, thumbnail-by-default display, and
// reference-counted blob cleanup automatically.
const GENERATED_SESSION_ID = 'generated';

function generatedRef(imageId: string, mimeType = 'image/png') {
  return { imageId, sessionId: GENERATED_SESSION_ID, mimeType };
}

interface GalleryGridProps {
  images: GalleryImage[];
  onReuseAsInput: (ref: ImageRef) => void;
  onSendToChat?: (imageId: string) => void;
}

export function GalleryGrid({
  images,
  onReuseAsInput,
  onSendToChat,
}: GalleryGridProps) {
  if (images.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 text-sm text-neutral-500 dark:text-neutral-400">
        No images yet. Press Generate.
      </div>
    );
  }

  return (
    <div
      className={classNames(
        'grid gap-3',
        images.length === 1
          ? 'grid-cols-1'
          : images.length <= 2
            ? 'grid-cols-1 sm:grid-cols-2'
            : 'grid-cols-2 sm:grid-cols-2 lg:grid-cols-3',
      )}
    >
      {images.map((img) => (
        <GalleryItem
          key={img.imageId}
          image={img}
          onReuseAsInput={onReuseAsInput}
          onSendToChat={onSendToChat}
        />
      ))}
    </div>
  );
}

function GalleryItem({
  image,
  onReuseAsInput,
  onSendToChat,
}: {
  image: GalleryImage;
  onReuseAsInput: (ref: ImageRef) => void;
  onSendToChat?: (imageId: string) => void;
}) {
  const ref = generatedRef(image.imageId);
  const fullUrl = getImageUrl(ref, false);

  const download = async () => {
    let url: string | null = null;
    try {
      const res = await fetch(fullUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${image.imageId}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      console.error('Download failed', e);
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  };

  const openFull = () => window.open(fullUrl, '_blank', 'noopener');

  return (
    <div className="group relative rounded-xl overflow-hidden bg-neutral-100 dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800">
      <OptimizedImage
        imageRef={ref}
        alt={image.prompt}
        useThumbnail
        className="w-full h-auto block"
      />
      <div
        className={classNames(
          'absolute inset-x-0 bottom-0 p-2',
          'bg-gradient-to-t from-black/80 to-transparent',
          'opacity-0 group-hover:opacity-100 transition-opacity',
          'flex gap-1 justify-end',
        )}
      >
        <Tooltip content="Use as input for next edit" position="top">
          <IconButton
            icon={<IconEdit size={16} />}
            onClick={() => onReuseAsInput(ref)}
            variant="ghost"
            size="sm"
            aria-label="Use as input for next edit"
          />
        </Tooltip>
        {onSendToChat && (
          <Tooltip content="Send to chat" position="top">
            <IconButton
              icon={<IconMessage size={16} />}
              onClick={() => onSendToChat(image.imageId)}
              variant="ghost"
              size="sm"
              aria-label="Send to chat"
            />
          </Tooltip>
        )}
        <Tooltip content="Download" position="top">
          <IconButton
            icon={<IconDownload size={16} />}
            onClick={download}
            variant="ghost"
            size="sm"
            aria-label="Download"
          />
        </Tooltip>
        <Tooltip content="Open full size" position="top">
          <IconButton
            icon={<IconExternalLink size={16} />}
            onClick={openFull}
            variant="ghost"
            size="sm"
            aria-label="Open full size"
          />
        </Tooltip>
      </div>
    </div>
  );
}
