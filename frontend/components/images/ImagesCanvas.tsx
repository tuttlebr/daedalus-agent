'use client';

import {
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconMessage,
  IconTrash,
} from '@tabler/icons-react';
import React, { memo, useMemo } from 'react';

import { useIsMobile, useMediaQuery } from '@/hooks/useMediaQuery';

import { getImageUrl } from '@/utils/app/imageHandler';

import { OptimizedImage } from '@/components/chat/OptimizedImage';
import { IconButton, Tooltip } from '@/components/primitives';

import type {
  GalleryImage,
  GenerationStatus,
  ImageRef,
} from '@/state/imagePanelStore';
import classNames from 'classnames';

const GENERATED_SESSION_ID = 'generated';

function generatedRef(imageId: string, mimeType = 'image/png'): ImageRef {
  return { imageId, sessionId: GENERATED_SESSION_ID, mimeType };
}

interface ImagesCanvasProps {
  images: GalleryImage[];
  loading: boolean;
  expectedCount: number;
  generationStatus: GenerationStatus;
  elapsedMs: number;
  selectedImageId: string | null;
  onSelectImage: (imageId: string) => void;
  onReuseAsInput: (ref: ImageRef) => void;
  onSendToChat?: (imageId: string) => void;
  onDelete: (imageId: string) => void;
}

/**
 * Grid of generated outputs. Columns adapt to viewport:
 * mobile (2), tablet (3), desktop (4). Empty state shows faint
 * grid lines that telegraph where outputs will appear.
 */
export const ImagesCanvas = memo(function ImagesCanvas({
  images,
  loading,
  expectedCount,
  generationStatus,
  elapsedMs,
  selectedImageId,
  onSelectImage,
  onReuseAsInput,
  onSendToChat,
  onDelete,
}: ImagesCanvasProps) {
  const isMobile = useIsMobile();
  const isTablet = useMediaQuery('(min-width: 768px) and (max-width: 1023px)');
  const cols = isMobile ? 2 : isTablet ? 3 : 4;
  const baseRows = isMobile ? 3 : 2;

  const loadingSlots = loading ? Math.max(1, expectedCount) : 0;
  const populated = Math.max(images.length, loadingSlots);
  const rows = Math.max(baseRows, Math.ceil(populated / cols));
  const totalCells = cols * rows;

  const cells = useMemo(
    () => Array.from({ length: totalCells }, (_, i) => i),
    [totalCells],
  );

  return (
    <div className="relative w-full h-full">
      <div
        className={classNames(
          'grid gap-0 h-full',
          'divide-x divide-y divide-neutral-800/60',
          'border-y border-neutral-800/60',
        )}
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        }}
      >
        {cells.map((idx) => {
          const img = images[idx];
          return (
            <div
              key={img ? img.imageId : `empty-${cols}-${idx}`}
              className="relative group overflow-hidden min-h-0"
            >
              {loading && idx < loadingSlots ? (
                <LoadingCell
                  index={idx}
                  count={loadingSlots}
                  status={generationStatus}
                  elapsedMs={elapsedMs}
                />
              ) : img ? (
                <CanvasTile
                  image={img}
                  selected={selectedImageId === img.imageId}
                  onSelect={() => onSelectImage(img.imageId)}
                  onReuseAsInput={onReuseAsInput}
                  onSendToChat={onSendToChat}
                  onDelete={onDelete}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
});

function LoadingCell({
  index,
  count,
  status,
  elapsedMs,
}: {
  index: number;
  count: number;
  status: GenerationStatus;
  elapsedMs: number;
}) {
  const label =
    status === 'queued'
      ? 'Queued'
      : status === 'submitting'
      ? 'Submitting'
      : status === 'finalizing'
      ? 'Finalizing'
      : 'Generating';

  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="w-6 h-6 rounded-full border-2 border-neutral-700 border-t-nvidia-green animate-spin" />
        <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
          {label}
        </div>
        <div className="text-[10px] text-neutral-600">
          {index + 1}/{count} · {Math.floor(elapsedMs / 1000)}s
        </div>
      </div>
    </div>
  );
}

const CanvasTile = memo(function CanvasTile({
  image,
  selected,
  onSelect,
  onReuseAsInput,
  onSendToChat,
  onDelete,
}: {
  image: GalleryImage;
  selected: boolean;
  onSelect: () => void;
  onReuseAsInput: (ref: ImageRef) => void;
  onSendToChat?: (imageId: string) => void;
  onDelete: (imageId: string) => void;
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
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={classNames(
        'absolute inset-0 block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvidia-green/60',
        selected && 'ring-2 ring-inset ring-nvidia-green/70',
      )}
      aria-label="Select generated image"
    >
      <OptimizedImage
        imageRef={ref}
        alt={image.prompt}
        useThumbnail
        className="w-full h-full object-cover"
      />
      <div
        className={classNames(
          'absolute inset-x-0 bottom-0 p-2',
          'bg-gradient-to-t from-black/80 to-transparent',
          'opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100',
          'flex gap-1 justify-end',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <Tooltip content="Use as input for next edit" position="top">
          <IconButton
            icon={<IconEdit size={18} />}
            onClick={() => onReuseAsInput(ref)}
            variant="ghost"
            size="md"
            aria-label="Use as input for next edit"
          />
        </Tooltip>
        {onSendToChat && (
          <Tooltip content="Send to chat" position="top">
            <IconButton
              icon={<IconMessage size={18} />}
              onClick={() => onSendToChat(image.imageId)}
              variant="ghost"
              size="md"
              aria-label="Send to chat"
            />
          </Tooltip>
        )}
        <Tooltip content="Download" position="top">
          <IconButton
            icon={<IconDownload size={18} />}
            onClick={download}
            variant="ghost"
            size="md"
            aria-label="Download"
            className="hidden sm:inline-flex"
          />
        </Tooltip>
        <Tooltip content="Open full size" position="top">
          <IconButton
            icon={<IconExternalLink size={18} />}
            onClick={openFull}
            variant="ghost"
            size="md"
            aria-label="Open full size"
            className="hidden sm:inline-flex"
          />
        </Tooltip>
        <Tooltip content="Remove from grid" position="top">
          <IconButton
            icon={<IconTrash size={18} />}
            onClick={() => onDelete(image.imageId)}
            variant="danger"
            size="md"
            aria-label="Remove from grid"
          />
        </Tooltip>
      </div>
    </div>
  );
});
