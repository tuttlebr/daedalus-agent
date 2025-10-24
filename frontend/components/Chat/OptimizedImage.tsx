import React, { useState, useEffect, useRef, memo } from 'react';
import { IconPhoto, IconMaximize, IconX, IconExclamationCircle, IconDownload } from '@tabler/icons-react';
import { ImageReference, getImageUrl, fetchImageAsBlob, revokeImageBlob } from '@/utils/app/imageHandler';

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
  const [isVisible, setIsVisible] = useState(false); // Start as not visible for lazy loading
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Get the image source - use blob URL if available, otherwise fallback
  const imageSrc = blobUrl || (imageRef ? getImageUrl(imageRef) : base64Data || '');

  // Set up Intersection Observer for lazy loading
  useEffect(() => {
    if (!containerRef.current) return;

    const options = {
      root: null,
      rootMargin: '50px', // Start loading 50px before visible
      threshold: 0.01
    };

    observerRef.current = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !isVisible) {
          setIsVisible(true);
          observerRef.current?.disconnect();
        }
      });
    }, options);

    observerRef.current.observe(containerRef.current);

    return () => {
      observerRef.current?.disconnect();
    };
  }, [isVisible]);

  // Fetch image as blob when visible
  useEffect(() => {
    if (!isVisible || !imageRef || blobUrl) return;

    let cancelled = false;

    const loadImageAsBlob = async () => {
      try {
        setIsLoading(true);
        setError(false);

        const url = await fetchImageAsBlob(imageRef);

        if (!cancelled) {
          setBlobUrl(url);
        }
      } catch (err) {
        console.error('Failed to load image as blob:', err);
        if (!cancelled) {
          setError(true);
          setIsLoading(false);
        }
      }
    };

    loadImageAsBlob();

    return () => {
      cancelled = true;
    };
  }, [isVisible, imageRef, blobUrl]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrl && imageRef) {
        revokeImageBlob(imageRef.imageId);
      }
    };
  }, [blobUrl, imageRef]);

  const handleImageLoad = () => {
    console.log('OptimizedImage: Image loaded successfully', imageSrc);
    setIsLoading(false);
    setError(false);
  };

  const handleImageError = () => {
    console.error('OptimizedImage: Failed to load image', imageSrc);
    setIsLoading(false);
    setError(true);
  };

  const toggleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsFullscreen(!isFullscreen);
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      let blob: Blob;

      // Use existing blob if available
      if (blobUrl) {
        const response = await fetch(blobUrl);
        blob = await response.blob();
      } else {
        // Fetch the image as a blob
        const response = await fetch(imageSrc);
        blob = await response.blob();
      }

      const fileName = alt ? `${alt}.png` : `image-${imageRef?.imageId || Date.now()}.png`;

      // Try Web Share API first (mobile devices)
      if (navigator.canShare && navigator.share) {
        try {
          const file = new File([blob], fileName, { type: blob.type || 'image/png' });

          // Check if we can share this file
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({
              files: [file],
              title: 'Share Image',
              text: alt || 'Image from chat',
            });
            return; // Successfully shared, exit early
          }
        } catch (shareErr) {
          // If share fails or is cancelled, fall through to download
          console.log('Share cancelled or failed, falling back to download');
        }
      }

      // Fallback: Standard download (desktop or if share not supported)
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download image:', err);
    }
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
        className={`relative inline-block max-w-full group ${className}`}
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
                block max-w-full h-auto rounded-lg border border-gray-200 dark:border-gray-700
                cursor-pointer hover:shadow-lg transition-shadow duration-200
                ${className}
              `}
              style={{
                opacity: isLoading ? 0 : 1,
                visibility: isLoading ? 'hidden' : 'visible',
                pointerEvents: isLoading ? 'none' : 'auto',
                transitionProperty: 'opacity, visibility',
              }}
              onClick={toggleFullscreen}
              loading="lazy"
              decoding="async"
            />

            {/* Action buttons overlay */}
            {!isLoading && (
              <div className="absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 sm:opacity-100">
                <button
                  className="bg-black/50 hover:bg-black/70 text-white p-2 rounded-lg"
                  onClick={handleDownload}
                  aria-label="Download image"
                  title="Download as PNG"
                >
                  <IconDownload size={20} />
                </button>
                <button
                  className="bg-black/50 hover:bg-black/70 text-white p-2 rounded-lg"
                  onClick={toggleFullscreen}
                  aria-label="View fullscreen"
                  title="View fullscreen"
                >
                  <IconMaximize size={20} />
                </button>
              </div>
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
          {/* Action buttons */}
          <div className="absolute top-4 right-4 flex gap-2">
            <button
              className="text-white hover:text-gray-300 p-2 rounded-lg bg-black/50 hover:bg-black/70 transition-colors"
              onClick={handleDownload}
              aria-label="Download image"
              title="Download as PNG"
            >
              <IconDownload size={24} />
            </button>
            <button
              className="text-white hover:text-gray-300 p-2 rounded-lg bg-black/50 hover:bg-black/70 transition-colors"
              onClick={toggleFullscreen}
              aria-label="Close fullscreen"
              title="Close fullscreen"
            >
              <IconX size={24} />
            </button>
          </div>

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
