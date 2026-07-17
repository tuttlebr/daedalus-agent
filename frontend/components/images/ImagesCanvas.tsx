'use client';

import React, { memo, useMemo } from 'react';

import { useIsMobile, useMediaQuery } from '@/hooks/useMediaQuery';

import { getImageOutputMimeType } from '@/utils/app/imageModelCapabilities';

import { OptimizedImage } from '@/components/chat/OptimizedImage';

import type {
  GalleryImage,
  GenerationStatus,
  ImageRef,
} from '@/state/imagePanelStore';
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

interface ImagesCanvasProps {
  images: GalleryImage[];
  loading: boolean;
  expectedCount: number;
  generationStatus: GenerationStatus;
  elapsedMs: number;
  selectedImageId: string | null;
  onSelectImage: (imageId: string) => void;
  onOpenSelectedImage?: () => void;
  emptyState?: React.ReactNode;
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
  onOpenSelectedImage,
  emptyState,
}: ImagesCanvasProps) {
  const isMobile = useIsMobile();
  const isTablet = useMediaQuery('(min-width: 768px) and (max-width: 1023px)');
  const isLarge = useMediaQuery('(min-width: 1024px)');
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
              {img ? (
                <CanvasTile
                  image={img}
                  selected={selectedImageId === img.imageId}
                  onSelect={() => {
                    onSelectImage(img.imageId);
                    if (!isLarge) onOpenSelectedImage?.();
                  }}
                />
              ) : loading && idx < loadingSlots ? (
                <LoadingCell
                  index={idx}
                  count={loadingSlots}
                  status={generationStatus}
                  elapsedMs={elapsedMs}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {!loading && images.length === 0 && emptyState && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-5 pointer-events-none">
          {emptyState}
        </div>
      )}
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
}: {
  image: GalleryImage;
  selected: boolean;
  onSelect: () => void;
}) {
  const ref = generatedRef(image);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={classNames(
        'absolute inset-0 block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvidia-green/60',
        selected && 'ring-2 ring-inset ring-nvidia-green/70',
      )}
      aria-label="Open generated image actions"
    >
      <OptimizedImage
        imageRef={ref}
        alt={image.prompt}
        useThumbnail
        showControls={false}
        enableFullscreen={false}
        className="w-full h-full bg-black/40 object-contain"
      />
      {image.partial && (
        <div className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-neutral-200">
          Partial
        </div>
      )}
      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2 pb-2 pt-8 text-left text-[10px] font-medium text-white opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
        {selected ? 'Selected · view actions' : 'Tap to view actions'}
      </span>
    </button>
  );
});
