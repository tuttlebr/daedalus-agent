'use client';

import { memo, useState, useCallback } from 'react';
import classNames from 'classnames';
import { IconX, IconChevronLeft, IconChevronRight, IconDownload } from '@tabler/icons-react';
import { IconButton } from '@/components/primitives';

interface ImageItem {
  src: string;
  alt?: string;
  thumbnailSrc?: string;
}

interface ImageGalleryProps {
  images: ImageItem[];
  className?: string;
}

/**
 * Grid of images with lightbox on click.
 * Supports keyboard navigation (arrow keys, Escape).
 */
export const ImageGallery = memo(({ images, className = '' }: ImageGalleryProps) => {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const openLightbox = useCallback((i: number) => setLightboxIndex(i), []);
  const closeLightbox = useCallback(() => setLightboxIndex(null), []);

  const navigate = useCallback((dir: -1 | 1) => {
    setLightboxIndex((prev) => {
      if (prev === null) return null;
      return (prev + dir + images.length) % images.length;
    });
  }, [images.length]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') navigate(-1);
    if (e.key === 'ArrowRight') navigate(1);
  }, [closeLightbox, navigate]);

  const handleDownload = useCallback(() => {
    if (lightboxIndex === null) return;
    const a = document.createElement('a');
    a.href = images[lightboxIndex].src;
    a.download = images[lightboxIndex].alt || `image-${lightboxIndex}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [lightboxIndex, images]);

  if (!images.length) return null;

  return (
    <>
      {/* Grid */}
      <div className={classNames(
        'grid gap-2',
        images.length === 1 ? 'grid-cols-1' :
        images.length === 2 ? 'grid-cols-2' :
        'grid-cols-2 sm:grid-cols-3',
        className
      )}>
        {images.map((img, i) => (
          <button
            key={i}
            onClick={() => openLightbox(i)}
            className="relative aspect-square rounded-lg overflow-hidden bg-dark-bg-tertiary border border-white/5 hover:border-nvidia-green/30 transition-colors group"
          >
            <img
              src={img.thumbnailSrc || img.src}
              alt={img.alt || `Image ${i + 1}`}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              loading="lazy"
            />
          </button>
        ))}
      </div>

      {/* Lightbox */}
      {lightboxIndex !== null && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-xl"
          onClick={closeLightbox}
          onKeyDown={handleKeyDown}
          tabIndex={0}
          role="dialog"
          aria-modal="true"
          aria-label="Image lightbox"
        >
          {/* Close */}
          <div className="absolute top-4 right-4 z-10 flex gap-2">
            <IconButton icon={<IconDownload />} aria-label="Download" variant="ghost" size="md" onClick={(e) => { e.stopPropagation(); handleDownload(); }} className="text-white/70 hover:text-white" />
            <IconButton icon={<IconX />} aria-label="Close" variant="ghost" size="md" onClick={closeLightbox} className="text-white/70 hover:text-white" />
          </div>

          {/* Navigation */}
          {images.length > 1 && (
            <>
              <button className="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors" onClick={(e) => { e.stopPropagation(); navigate(-1); }}>
                <IconChevronLeft size={24} />
              </button>
              <button className="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors" onClick={(e) => { e.stopPropagation(); navigate(1); }}>
                <IconChevronRight size={24} />
              </button>
            </>
          )}

          {/* Image */}
          <img
            src={images[lightboxIndex].src}
            alt={images[lightboxIndex].alt || ''}
            className="max-w-[90vw] max-h-[90vh] object-contain animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          />

          {/* Counter */}
          {images.length > 1 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-sm text-white/60">
              {lightboxIndex + 1} / {images.length}
            </div>
          )}
        </div>
      )}
    </>
  );
});

ImageGallery.displayName = 'ImageGallery';
