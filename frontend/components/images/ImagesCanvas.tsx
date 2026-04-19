'use client';

import React from 'react';
import classNames from 'classnames';
import {
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconMessage,
  IconTrash,
} from '@tabler/icons-react';
import { IconButton, Tooltip } from '@/components/primitives';
import { OptimizedImage } from '@/components/chat/OptimizedImage';
import { getImageUrl } from '@/utils/app/imageHandler';
import type { GalleryImage, ImageRef } from '@/state/imagePanelStore';

const GENERATED_SESSION_ID = 'generated';
const GRID_COLS = 4;
const GRID_ROWS = 2;

function generatedRef(imageId: string, mimeType = 'image/png'): ImageRef {
  return { imageId, sessionId: GENERATED_SESSION_ID, mimeType };
}

interface ImagesCanvasProps {
  images: GalleryImage[];
  loading: boolean;
  expectedCount: number;
  onReuseAsInput: (ref: ImageRef) => void;
  onSendToChat?: (imageId: string) => void;
  onDelete: (imageId: string) => void;
}

/**
 * The main working canvas. When empty, shows a faint 4×2 grid-line
 * placeholder that telegraphs where generated outputs will appear. When
 * populated, each output fills a cell (left-to-right, top-to-bottom).
 * Extra rows are added for n > 8.
 */
export function ImagesCanvas({
  images,
  loading,
  expectedCount,
  onReuseAsInput,
  onSendToChat,
  onDelete,
}: ImagesCanvasProps) {
  const cols = GRID_COLS;
  const loadingSlots = loading ? Math.max(1, expectedCount) : 0;
  const populated = Math.max(images.length, loadingSlots);
  const rows = Math.max(GRID_ROWS, Math.ceil(populated / cols));
  const totalCells = cols * rows;

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
        {Array.from({ length: totalCells }).map((_, idx) => {
          const img = images[idx];
          return (
            <div
              key={img ? img.imageId : `empty-${idx}`}
              className="relative group overflow-hidden min-h-0"
            >
              {loading && idx < loadingSlots ? (
                <LoadingCell />
              ) : img ? (
                <CanvasTile
                  image={img}
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
}

function LoadingCell() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="w-6 h-6 rounded-full border-2 border-neutral-700 border-t-nvidia-green animate-spin" />
    </div>
  );
}

function CanvasTile({
  image,
  onReuseAsInput,
  onSendToChat,
  onDelete,
}: {
  image: GalleryImage;
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
    <div className="absolute inset-0">
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
        <Tooltip content="Remove from grid" position="top">
          <IconButton
            icon={<IconTrash size={16} />}
            onClick={() => onDelete(image.imageId)}
            variant="danger"
            size="sm"
            aria-label="Remove from grid"
          />
        </Tooltip>
      </div>
    </div>
  );
}
