import React, { useState, useEffect, useRef, memo } from 'react';
import { IconPhoto, IconMaximize, IconX, IconExclamationCircle } from '@tabler/icons-react';
import { ImageReference, getImageUrl } from '@/utils/app/imageHandler';

interface OptimizedImageProps {
  imageRef?: ImageReference;
  base64Data?: string;
  alt?: string;
  className?: string;
  mimeType?: string;
}

export const OptimizedImage = memo(({
  imageRef,
  base64Data,
  alt = 'Image attachment',
  className = '',
  mimeType = 'image/jpeg'
}: OptimizedImageProps) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Get the image source
  const imageSrc = imageRef ? getImageUrl(imageRef) : base64Data || '';

  // Set up intersection observer for lazy loading
  useEffect(() => {
    if (!containerRef.current) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            // Disconnect after image becomes visible
            observerRef.current?.disconnect();
          }
        });
      },
      {
        rootMargin: '100px', // Start loading 100px before image comes into view
        threshold: 0.01
      }
    );

    observerRef.current.observe(containerRef.current);

    return () => {
      observerRef.current?.disconnect();
    };
  }, []);

  const handleImageLoad = () => {
    setIsLoading(false);
    setError(false);
  };

  const handleImageError = () => {
    setIsLoading(false);
    setError(true);
    console.error('Failed to load image');
  };

  const toggleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsFullscreen(!isFullscreen);
  };

  // Prevent body scroll when fullscreen is open
  useEffect(() => {
    if (isFullscreen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isFullscreen]);

  return (
    <>
      <div
        ref={containerRef}
        className={`relative inline-block max-w-full ${className}`}
      >
        {/* Placeholder while loading or before visible */}
        {(!isVisible || isLoading) && !error && (
          <div className="flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 min-h-[200px] sm:min-h-[300px]">
            <div className="text-center p-4">
              <IconPhoto size={48} className="mx-auto mb-2 text-gray-400" />
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {isLoading ? 'Loading image...' : 'Image'}
              </p>
            </div>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="flex items-center justify-center p-4 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
            <IconExclamationCircle className="w-5 h-5 text-red-500 mr-2" />
            <p className="text-red-600 dark:text-red-400 text-sm">
              Failed to load image
            </p>
          </div>
        )}

        {/* Actual image (hidden until loaded) */}
        {isVisible && !error && (
          <>
            <img
              ref={imgRef}
              src={imageSrc}
              alt={alt}
              onLoad={handleImageLoad}
              onError={handleImageError}
              className={`
                ${isLoading ? 'hidden' : 'block'}
                max-w-full h-auto rounded-lg border border-gray-200 dark:border-gray-700
                cursor-pointer hover:shadow-lg transition-shadow duration-200
                ${className}
              `}
              onClick={toggleFullscreen}
              loading="lazy"
              decoding="async"
            />

            {/* Fullscreen button overlay */}
            {!isLoading && (
              <button
                className="absolute top-2 right-2 bg-black/50 hover:bg-black/70 text-white p-2 rounded-lg opacity-0 hover:opacity-100 transition-opacity duration-200 sm:opacity-100"
                onClick={toggleFullscreen}
                aria-label="View fullscreen"
              >
                <IconMaximize size={20} />
              </button>
            )}
          </>
        )}
      </div>

      {/* Fullscreen Modal */}
      {isFullscreen && !error && (
        <div
          className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center"
          onClick={toggleFullscreen}
        >
          {/* Close button */}
          <button
            className="absolute top-4 right-4 text-white hover:text-gray-300 p-2 rounded-lg bg-black/50 hover:bg-black/70 transition-colors"
            onClick={toggleFullscreen}
            aria-label="Close fullscreen"
          >
            <IconX size={24} />
          </button>

          {/* Fullscreen image */}
          <div className="relative max-w-full max-h-full p-4">
            <img
              src={imageSrc}
              alt={alt}
              className="max-w-full max-h-full object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}
    </>
  );
}, (prevProps, nextProps) => {
  // Only re-render if imageRef or base64Data changes
  return (
    prevProps.imageRef?.imageId === nextProps.imageRef?.imageId &&
    prevProps.base64Data === nextProps.base64Data
  );
});

OptimizedImage.displayName = 'OptimizedImage';
