import { FC, useState, useCallback, useEffect, useRef } from 'react';
import { IconChevronLeft, IconChevronRight, IconX } from '@tabler/icons-react';
import { ImageReference } from '@/utils/app/imageHandler';
import { OptimizedImage } from './OptimizedImage';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface ImageGalleryProps {
  images: ImageReference[];
}

export const ImageGallery: FC<ImageGalleryProps> = ({ images }) => {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const touchStartX = useRef<number | null>(null);

  const isOpen = lightboxIndex !== null;

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null);
  }, []);

  const { containerRef } = useFocusTrap({
    isActive: isOpen,
    onEscape: closeLightbox,
  });

  const goToPrev = useCallback(() => {
    setLightboxIndex((prev) => {
      if (prev === null) return null;
      return prev > 0 ? prev - 1 : images.length - 1;
    });
  }, [images.length]);

  const goToNext = useCallback(() => {
    setLightboxIndex((prev) => {
      if (prev === null) return null;
      return prev < images.length - 1 ? prev + 1 : 0;
    });
  }, [images.length]);

  // Keyboard navigation (ArrowLeft / ArrowRight)
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goToNext();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, goToPrev, goToNext]);

  // Prevent body scroll when lightbox is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Touch swipe handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (touchStartX.current === null) return;
      const deltaX = e.changedTouches[0].clientX - touchStartX.current;
      const SWIPE_THRESHOLD = 50;

      if (deltaX > SWIPE_THRESHOLD) {
        goToPrev();
      } else if (deltaX < -SWIPE_THRESHOLD) {
        goToNext();
      }

      touchStartX.current = null;
    },
    [goToPrev, goToNext],
  );

  // Preload adjacent images
  const preloadTargets =
    lightboxIndex !== null
      ? [
          images[(lightboxIndex - 1 + images.length) % images.length],
          images[(lightboxIndex + 1) % images.length],
        ]
      : [];

  if (images.length === 0) return null;

  return (
    <>
      {/* Grid view */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {images.map((img, idx) => (
          <button
            key={img.imageId}
            type="button"
            className="relative overflow-hidden rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
            onClick={() => setLightboxIndex(idx)}
            aria-label={`View image ${idx + 1} of ${images.length}`}
          >
            <OptimizedImage
              imageRef={img}
              alt={`Image ${idx + 1}`}
              className="w-full h-auto object-cover aspect-square cursor-pointer"
            />
          </button>
        ))}
      </div>

      {/* Fullscreen lightbox */}
      {isOpen && lightboxIndex !== null && (
        <div
          ref={containerRef}
          className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onClick={closeLightbox}
          role="dialog"
          aria-modal="true"
          aria-label="Image lightbox"
        >
          {/* Close button */}
          <button
            className="absolute top-4 right-4 text-white hover:text-gray-300 p-2 rounded-lg bg-black/50 hover:bg-black/70 transition-colors z-10"
            onClick={(e) => {
              e.stopPropagation();
              closeLightbox();
            }}
            aria-label="Close lightbox"
          >
            <IconX size={24} />
          </button>

          {/* Previous arrow */}
          {images.length > 1 && (
            <button
              className="absolute left-4 top-1/2 -translate-y-1/2 text-white hover:text-gray-300 p-2 rounded-lg bg-black/50 hover:bg-black/70 transition-colors z-10"
              onClick={(e) => {
                e.stopPropagation();
                goToPrev();
              }}
              aria-label="Previous image"
            >
              <IconChevronLeft size={28} />
            </button>
          )}

          {/* Next arrow */}
          {images.length > 1 && (
            <button
              className="absolute right-4 top-1/2 -translate-y-1/2 text-white hover:text-gray-300 p-2 rounded-lg bg-black/50 hover:bg-black/70 transition-colors z-10"
              onClick={(e) => {
                e.stopPropagation();
                goToNext();
              }}
              aria-label="Next image"
            >
              <IconChevronRight size={28} />
            </button>
          )}

          {/* Index indicator */}
          {images.length > 1 && (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-black/70 text-white text-sm px-4 py-1.5 rounded-full z-10">
              {lightboxIndex + 1}/{images.length}
            </div>
          )}

          {/* Current image */}
          <div
            className="relative max-w-full max-h-full p-12"
            onClick={(e) => e.stopPropagation()}
          >
            <OptimizedImage
              imageRef={images[lightboxIndex]}
              alt={`Image ${lightboxIndex + 1}`}
              className="max-w-full max-h-[85vh] object-contain"
            />
          </div>

          {/* Preload adjacent images (hidden) */}
          {preloadTargets.map((img) => (
            <div key={`preload-${img.imageId}`} className="hidden" aria-hidden="true">
              <OptimizedImage
                imageRef={img}
                alt=""
                className="hidden"
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
};
