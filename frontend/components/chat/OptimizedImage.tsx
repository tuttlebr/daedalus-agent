import React, { useState, useEffect, useRef, memo, useCallback } from 'react';
import { IconMaximize, IconX, IconExclamationCircle, IconDownload } from '@tabler/icons-react';
import { ImageReference, getImageUrl, fetchImageAsBlob, revokeImageBlob } from '@/utils/app/imageHandler';
import { Skeleton } from '@/components/primitives/Skeleton';
const ImageSkeleton = ({ className = '', aspectRatio }: { className?: string; aspectRatio?: string }) => <Skeleton variant="rectangular" className={className + ' w-full rounded-lg ' + (aspectRatio === 'landscape' ? 'aspect-video' : 'aspect-square')} />;
import { Logger } from '@/utils/logger';

const logger = new Logger('OptimizedImage');

interface OptimizedImageProps {
  imageRef?: ImageReference;
  base64Data?: string;
  alt?: string;
  className?: string;
  mimeType?: string;
  useThumbnail?: boolean; // Default true - use thumbnail for display
}

export const OptimizedImage = memo(({
  imageRef,
  base64Data,
  alt = 'Image attachment',
  className = '',
  mimeType = 'image/jpeg',
  useThumbnail = true // Use thumbnail by default for better performance
}: OptimizedImageProps) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  const [isVisible, setIsVisible] = useState(false); // Start as not visible for lazy loading
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [fullBlobUrl, setFullBlobUrl] = useState<string | null>(null); // Full resolution for fullscreen/download
  const imgRef = useRef<HTMLImageElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false); // Track if image has been loaded
  const unmountingRef = useRef(false); // Track if component is unmounting

  // Get the image source - use blob URL if available, otherwise fallback
  const imageSrc = blobUrl || (imageRef ? getImageUrl(imageRef, useThumbnail) : base64Data || '');

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

  // Fetch thumbnail as blob when visible
  useEffect(() => {
    if (!isVisible || !imageRef || blobUrl) return;

    let cancelled = false;
    loadedRef.current = false; // Reset loaded state for new image

    const loadImageAsBlob = async () => {
      try {
        setIsLoading(true);
        setError(false);

        // Fetch thumbnail for display (faster, smaller)
        const url = await fetchImageAsBlob(imageRef, useThumbnail);

        if (!cancelled) {
          setBlobUrl(url);
        }
      } catch (err) {
        logger.error('Failed to load image as blob:', err);
        if (!cancelled) {
          setError(true);
          setIsLoading(false);
          loadedRef.current = true; // Mark as "loaded" even on error
        }
      }
    };

    loadImageAsBlob();

    return () => {
      cancelled = true;
    };
  }, [isVisible, imageRef, blobUrl, useThumbnail]);

  // Enhanced cleanup blob URL on unmount or when imageRef changes
  useEffect(() => {
    const currentBlobUrl = blobUrl;
    const currentFullBlobUrl = fullBlobUrl;
    const currentImageRef = imageRef;
    const currentUseThumbnail = useThumbnail;

    return () => {
      unmountingRef.current = true;

      // Revoke thumbnail blob
      if (currentBlobUrl && currentImageRef) {
        // Only revoke if image has loaded or failed to load
        // This prevents revoking while the image is still loading
        if (loadedRef.current || error) {
          const cacheKey = currentUseThumbnail
            ? `${currentImageRef.imageId}-thumb`
            : currentImageRef.imageId;
          revokeImageBlob(cacheKey);
        } else {
          // Image is still loading - defer revocation
          // Set a timeout to ensure cleanup happens eventually
          setTimeout(() => {
            if (currentBlobUrl && currentImageRef) {
              const cacheKey = currentUseThumbnail
                ? `${currentImageRef.imageId}-thumb`
                : currentImageRef.imageId;
              revokeImageBlob(cacheKey);
            }
          }, 5000); // Give image 5 seconds to load
        }
      }

      // Revoke full resolution blob if it was loaded
      if (currentFullBlobUrl && currentImageRef) {
        revokeImageBlob(currentImageRef.imageId);
      }
    };
  }, [blobUrl, fullBlobUrl, imageRef, error, useThumbnail]);

  const handleImageLoad = () => {
    setIsLoading(false);
    setError(false);
    loadedRef.current = true;

    // If component is unmounting and image just loaded, revoke now
    if (unmountingRef.current && blobUrl && imageRef) {
      const cacheKey = useThumbnail ? `${imageRef.imageId}-thumb` : imageRef.imageId;
      revokeImageBlob(cacheKey);
    }
  };

  const handleImageError = useCallback(() => {
    logger.error('Failed to load image');

    // If we have a blob URL that failed (might have been revoked), try to refetch
    if (blobUrl && imageRef) {
      setBlobUrl(null); // Clear the invalid blob URL to trigger refetch
      setIsLoading(true);
      setError(false);
      loadedRef.current = false;

      // Refetch the image (with thumbnail setting)
      fetchImageAsBlob(imageRef, useThumbnail)
        .then((newUrl) => {
          if (!unmountingRef.current) {
            setBlobUrl(newUrl);
          }
        })
        .catch((err) => {
          logger.error('Refetch also failed:', err);
          if (!unmountingRef.current) {
            setIsLoading(false);
            setError(true);
          }
        });
    } else {
      setIsLoading(false);
      setError(true);
    }
  }, [blobUrl, imageRef, imageSrc]);

  const toggleFullscreen = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();

    // When opening fullscreen, fetch full resolution image if not already loaded
    if (!isFullscreen && imageRef && !fullBlobUrl && useThumbnail) {
      try {
        const url = await fetchImageAsBlob(imageRef, false); // false = full resolution
        setFullBlobUrl(url);
      } catch (err) {
        logger.error('Failed to load full resolution image:', err);
        // Fall back to thumbnail
      }
    }

    setIsFullscreen(!isFullscreen);
  }, [isFullscreen, imageRef, fullBlobUrl, useThumbnail]);

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      let blob: Blob;

      // Always download full resolution image
      if (imageRef) {
        // Fetch full resolution for download (not thumbnail)
        const fullUrl = getImageUrl(imageRef, false);
        const response = await fetch(fullUrl);
        blob = await response.blob();
      } else if (blobUrl) {
        const response = await fetch(blobUrl);
        blob = await response.blob();
      } else {
        // Fetch the image as a blob
        const response = await fetch(imageSrc);
        blob = await response.blob();
      }

      const fileName = alt ? `${alt}.png` : `image-${imageRef?.imageId || Date.now()}.png`;

      // Try Web Share API first (mobile devices)
      if (typeof navigator !== 'undefined' && navigator.canShare && navigator.share) {
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
          logger.info('Share cancelled or failed, falling back to download');
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
      logger.error('Failed to download image:', err);
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
          <ImageSkeleton
            aspectRatio="landscape"
            className="min-h-[200px] sm:min-h-[300px] w-full max-w-md"
          />
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
              title="Download as PNG (Full Quality)"
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

          {/* Fullscreen image - use full resolution if available */}
          <div className="relative max-w-full max-h-full p-4">
            <img
              src={fullBlobUrl || imageSrc}
              alt={alt}
              className="max-w-full max-h-full object-contain"
              onClick={(e) => e.stopPropagation()}
            />
            {/* Loading indicator while fetching full resolution */}
            {!fullBlobUrl && useThumbnail && imageRef && (
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/70 text-white text-xs px-3 py-1 rounded-full">
                Loading full resolution...
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}, (prevProps, nextProps) => {
  // Only re-render if imageRef, base64Data, or useThumbnail changes
  return (
    prevProps.imageRef?.imageId === nextProps.imageRef?.imageId &&
    prevProps.base64Data === nextProps.base64Data &&
    prevProps.useThumbnail === nextProps.useThumbnail
  );
});

OptimizedImage.displayName = 'OptimizedImage';
