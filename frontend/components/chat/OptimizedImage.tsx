import {
  IconMaximize,
  IconX,
  IconExclamationCircle,
  IconDownload,
} from '@tabler/icons-react';
import React, { useState, useEffect, useRef, memo, useCallback } from 'react';

import { useFileSave } from '@/hooks/useFileSave';

import { getBlobCacheKey } from '@/utils/app/imageBlobCache';
import {
  ImageReference,
  getImageUrl,
  fetchImageAsBlob,
  revokeImageBlob,
} from '@/utils/app/imageHandler';
import { Logger } from '@/utils/logger';

import { Skeleton } from '@/components/primitives/Skeleton';
import { ModalSurface } from '@/components/surfaces/ModalSurface';

const ImageSkeleton = ({
  className = '',
  aspectRatio,
}: {
  className?: string;
  aspectRatio?: string;
}) => (
  <Skeleton
    variant="rectangular"
    className={
      className +
      ' w-full rounded-lg ' +
      (aspectRatio === 'landscape' ? 'aspect-video' : 'aspect-square')
    }
  />
);

const logger = new Logger('OptimizedImage');

interface OptimizedImageProps {
  imageRef?: ImageReference;
  base64Data?: string;
  alt?: string;
  className?: string;
  useThumbnail?: boolean; // Default true - use thumbnail for display
  /** Consumers with their own inspector should not render a second action bar. */
  showControls?: boolean;
  /** Let parent selection surfaces own tap/click behavior when needed. */
  enableFullscreen?: boolean;
}

export const OptimizedImage = memo(
  ({
    imageRef,
    base64Data,
    alt = 'Image attachment',
    className = '',
    useThumbnail = true, // Use thumbnail by default for better performance
    showControls = true,
    enableFullscreen = true,
  }: OptimizedImageProps) => {
    const { saveFile, fileSaveDialog } = useFileSave();
    const [downloadError, setDownloadError] = useState('');
    const [downloading, setDownloading] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(false);
    const [isVisible, setIsVisible] = useState(false); // Start as not visible for lazy loading
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [blobUrl, setBlobUrl] = useState<string | null>(null);
    const [fullBlobUrl, setFullBlobUrl] = useState<string | null>(null); // Full resolution for fullscreen/download
    const [fullResolutionLoading, setFullResolutionLoading] = useState(false);
    const imgRef = useRef<HTMLImageElement>(null);
    const observerRef = useRef<IntersectionObserver | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const loadedRef = useRef(false); // Track if image has been loaded
    const unmountingRef = useRef(false); // Track if component is unmounting

    // Get the image source - use blob URL if available, otherwise fallback
    const imageSrc =
      blobUrl ||
      (imageRef ? getImageUrl(imageRef, useThumbnail) : base64Data || '');

    // Set up Intersection Observer for lazy loading
    useEffect(() => {
      if (!containerRef.current) return;

      const options = {
        root: null,
        rootMargin: '50px', // Start loading 50px before visible
        threshold: 0.01,
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
          } else {
            revokeImageBlob(getBlobCacheKey(imageRef, useThumbnail), url);
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

    // Unmount tracker kept in its own empty-deps effect so dependency-change
    // cleanups below don't flip this flag and poison handleImageLoad/Error.
    useEffect(() => {
      unmountingRef.current = false;
      return () => {
        unmountingRef.current = true;
      };
    }, []);

    // Cleanup blob URL on unmount or when imageRef/blobUrl changes
    useEffect(() => {
      const currentBlobUrl = blobUrl;
      const currentFullBlobUrl = fullBlobUrl;
      const currentImageRef = imageRef;
      const currentUseThumbnail = useThumbnail;

      return () => {
        // Revoke thumbnail blob
        if (currentBlobUrl && currentImageRef) {
          revokeImageBlob(
            getBlobCacheKey(currentImageRef, currentUseThumbnail),
            currentBlobUrl,
          );
        }

        // Revoke full resolution blob if it was loaded
        if (currentFullBlobUrl && currentImageRef) {
          revokeImageBlob(
            getBlobCacheKey(currentImageRef, false),
            currentFullBlobUrl,
          );
        }
      };
    }, [blobUrl, fullBlobUrl, imageRef, useThumbnail]);

    const handleImageLoad = () => {
      setIsLoading(false);
      setError(false);
      loadedRef.current = true;

      // If component is unmounting and image just loaded, revoke now
      if (unmountingRef.current && blobUrl && imageRef) {
        revokeImageBlob(getBlobCacheKey(imageRef, useThumbnail), blobUrl);
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
    }, [blobUrl, imageRef, useThumbnail]);

    const toggleFullscreen = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      (e.currentTarget as HTMLElement).focus({ preventScroll: true });
      setIsFullscreen((open) => !open);
    }, []);

    useEffect(() => {
      if (!isFullscreen || !imageRef || fullBlobUrl || !useThumbnail) return;

      let cancelled = false;
      setFullResolutionLoading(true);

      const loadFullResolution = async () => {
        try {
          const url = await fetchImageAsBlob(imageRef, false); // false = full resolution
          if (!cancelled) {
            setFullBlobUrl(url);
          } else {
            revokeImageBlob(getBlobCacheKey(imageRef, false), url);
          }
        } catch (err) {
          logger.error('Failed to load full resolution image:', err);
          // Fall back to thumbnail
        } finally {
          if (!cancelled) {
            setFullResolutionLoading(false);
          }
        }
      };

      loadFullResolution();

      return () => {
        cancelled = true;
      };
    }, [isFullscreen, imageRef, fullBlobUrl, useThumbnail]);

    const handleDownload = async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (downloading) return;
      setDownloading(true);
      setDownloadError('');
      try {
        const fullUrl = imageRef ? getImageUrl(imageRef, false) : imageSrc;
        const response = await fetch(fullUrl);
        if (!response.ok) throw new Error('Image download failed');
        const blob = await response.blob();
        const extension =
          blob.type === 'image/jpeg' ? 'jpg' : blob.type.split('/')[1] || 'png';
        saveFile(blob, `${alt || 'image'}.${extension}`);
      } catch {
        setDownloadError('Could not prepare the image. Try again.');
      } finally {
        setDownloading(false);
      }
    };

    return (
      <>
        {fileSaveDialog}
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
            <div
              role="status"
              className="flex items-center justify-center p-4 bg-nvidia-red/10 rounded-lg border border-nvidia-red/30"
            >
              <IconExclamationCircle className="w-5 h-5 text-nvidia-red mr-2" />
              <p className="text-nvidia-red text-sm">Failed to load image</p>
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
                block max-w-full h-auto rounded-lg border border-separator
                ${
                  enableFullscreen ? 'cursor-pointer hover:shadow-lg' : ''
                } transition-shadow duration-200
                ${className}
              `}
                style={{
                  opacity: isLoading ? 0 : 1,
                  visibility: isLoading ? 'hidden' : 'visible',
                  pointerEvents: isLoading ? 'none' : 'auto',
                  transitionProperty: 'opacity, visibility',
                }}
                onClick={enableFullscreen ? toggleFullscreen : undefined}
                role={enableFullscreen ? 'button' : undefined}
                tabIndex={enableFullscreen ? 0 : undefined}
                onKeyDown={
                  enableFullscreen
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setIsFullscreen(true);
                        }
                      }
                    : undefined
                }
                loading="lazy"
                decoding="async"
              />

              {/* Action buttons overlay */}
              {!isLoading && showControls && (
                <div className="absolute top-2 right-2 flex gap-2 opacity-100 transition-opacity duration-200 touch-action-controls md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                  <button
                    type="button"
                    className="bg-panel text-primary p-2 rounded-lg shadow-sm"
                    onClick={handleDownload}
                    disabled={downloading}
                    aria-busy={downloading}
                    aria-label="Download image"
                    title="Save image"
                  >
                    <IconDownload size={20} />
                  </button>
                  <button
                    type="button"
                    className="bg-panel text-primary p-2 rounded-lg shadow-sm"
                    onClick={toggleFullscreen}
                    aria-label="View image fullscreen"
                    title="View fullscreen"
                  >
                    <IconMaximize size={20} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {downloadError && !isFullscreen && (
          <p role="alert" className="text-sm text-nvidia-red">
            {downloadError}
          </p>
        )}
        {/* Fullscreen Modal */}
        {isFullscreen && !error && (
          <ModalSurface
            open={isFullscreen}
            onClose={() => setIsFullscreen(false)}
            position="fullscreen"
            aria-label="Image preview"
            className="flex h-full w-full flex-col bg-app safe-y"
          >
            {/* Action buttons */}
            <div className="flex shrink-0 justify-end gap-2 px-4 pb-2">
              <button
                type="button"
                className="text-primary p-2 rounded-lg bg-control"
                onClick={handleDownload}
                disabled={downloading}
                aria-busy={downloading}
                aria-label="Download image"
                title="Save full-quality image"
              >
                <IconDownload size={24} />
              </button>
              <button
                type="button"
                className="text-primary p-2 rounded-lg bg-control"
                onClick={toggleFullscreen}
                aria-label="Close fullscreen"
                title="Close fullscreen"
              >
                <IconX size={24} />
              </button>
            </div>

            {downloadError && (
              <p role="alert" className="px-4 text-sm text-nvidia-red">
                {downloadError}
              </p>
            )}
            {/* Fullscreen image - use full resolution if available */}
            <div className="relative flex min-h-0 flex-1 items-center justify-center p-4">
              <img
                src={fullBlobUrl || imageSrc}
                alt={alt}
                className="h-full w-full object-contain"
                onClick={(e) => e.stopPropagation()}
              />
              {/* Loading indicator while fetching full resolution */}
              {fullResolutionLoading && useThumbnail && imageRef && (
                <div
                  role="status"
                  className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-panel text-primary text-xs px-3 py-1 rounded-full"
                >
                  Loading full resolution...
                </div>
              )}
            </div>
          </ModalSurface>
        )}
      </>
    );
  },
  (prevProps, nextProps) => {
    // Only re-render if image identity or presentation props change.
    return (
      prevProps.imageRef?.imageId === nextProps.imageRef?.imageId &&
      prevProps.imageRef?.sessionId === nextProps.imageRef?.sessionId &&
      prevProps.imageRef?.userId === nextProps.imageRef?.userId &&
      prevProps.base64Data === nextProps.base64Data &&
      prevProps.useThumbnail === nextProps.useThumbnail &&
      prevProps.showControls === nextProps.showControls &&
      prevProps.enableFullscreen === nextProps.enableFullscreen &&
      prevProps.className === nextProps.className &&
      prevProps.alt === nextProps.alt
    );
  },
);

OptimizedImage.displayName = 'OptimizedImage';
