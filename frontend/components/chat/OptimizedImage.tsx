import {
  IconMaximize,
  IconX,
  IconExclamationCircle,
  IconDownload,
} from '@tabler/icons-react';
import React, {
  useState,
  useEffect,
  useRef,
  memo,
  useCallback,
  useMemo,
} from 'react';

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
  /** Override image sizing independently of its wrapper. */
  imageClassName?: string;
  showLoadingPlaceholder?: boolean;
  onLoad?: () => void;
  useThumbnail?: boolean; // Default true - use thumbnail for display
  /** Consumers with their own inspector should not render a second action bar. */
  showControls?: boolean;
  /** Let parent selection surfaces own tap/click behavior when needed. */
  enableFullscreen?: boolean;
}

const ImageView = memo(
  ({
    imageRef,
    base64Data,
    alt = 'Image attachment',
    className = '',
    imageClassName,
    showLoadingPlaceholder = true,
    onLoad,
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
    const [retryAttempt, setRetryAttempt] = useState(0);

    // Get the image source - use blob URL if available, otherwise fallback
    const imageSrc = blobUrl || (!imageRef ? base64Data || '' : '');

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
      if (!isVisible || !imageRef) return;

      let cancelled = false;
      let acquiredUrl: string | null = null;
      setBlobUrl(null);

      const loadImageAsBlob = async () => {
        try {
          setIsLoading(true);
          setError(false);

          // Fetch thumbnail for display (faster, smaller)
          const url = await fetchImageAsBlob(imageRef, useThumbnail);

          if (!cancelled) {
            acquiredUrl = url;
            setBlobUrl(url);
          } else {
            revokeImageBlob(getBlobCacheKey(imageRef, useThumbnail), url);
          }
        } catch (err) {
          logger.error('Failed to load image as blob:', err);
          if (!cancelled) {
            setError(true);
            setIsLoading(false);
          }
        }
      };

      loadImageAsBlob();

      return () => {
        cancelled = true;
        if (acquiredUrl) {
          revokeImageBlob(getBlobCacheKey(imageRef, useThumbnail), acquiredUrl);
        }
      };
    }, [isVisible, imageRef, useThumbnail, retryAttempt]);

    const handleImageLoad = async (
      event: React.SyntheticEvent<HTMLImageElement>,
    ) => {
      const image = event.currentTarget;
      try {
        await image.decode?.();
        if (!image.isConnected) return;
        setIsLoading(false);
        setError(false);
        onLoad?.();
      } catch {
        if (image.isConnected) handleImageError();
      }
    };

    const handleImageError = useCallback(() => {
      logger.error('Failed to load image');
      // Retry through the same resource-owning effect, so a retry cannot
      // acquire a second untracked blob or publish after unmount.
      if (imageRef && retryAttempt === 0) {
        setRetryAttempt(1);
      } else {
        setIsLoading(false);
        setError(true);
      }
    }, [imageRef, retryAttempt]);

    const toggleFullscreen = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      (e.currentTarget as HTMLElement).focus({ preventScroll: true });
      setIsFullscreen((open) => !open);
    }, []);

    useEffect(() => {
      setFullBlobUrl(null);
      if (!isFullscreen || !imageRef || !useThumbnail) return;

      let cancelled = false;
      let acquiredUrl: string | null = null;
      setFullResolutionLoading(true);

      const loadFullResolution = async () => {
        try {
          const url = await fetchImageAsBlob(imageRef, false); // false = full resolution
          if (!cancelled) {
            acquiredUrl = url;
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
        if (acquiredUrl) {
          revokeImageBlob(getBlobCacheKey(imageRef, false), acquiredUrl);
        }
      };
    }, [isFullscreen, imageRef, useThumbnail]);

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
          {showLoadingPlaceholder && (!isVisible || isLoading) && !error && (
            <ImageSkeleton
              aspectRatio="landscape"
              className="min-h-[200px] sm:min-h-[300px] w-full max-w-md"
            />
          )}

          {/* Error state */}
          {error && (
            <div
              role="status"
              className="flex items-center justify-center p-4 bg-error/10 rounded-lg border border-error"
            >
              <IconExclamationCircle className="w-5 h-5 text-primary mr-2" />
              <p className="text-primary text-sm">Failed to load image</p>
            </div>
          )}

          {/* Actual image (hidden until loaded) */}
          {isVisible && !error && imageSrc && (
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
                ${imageClassName ?? className}
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
          <p role="alert" className="text-sm text-primary">
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
              <p role="alert" className="px-4 text-sm text-primary">
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
      prevProps.imageClassName === nextProps.imageClassName &&
      prevProps.showLoadingPlaceholder === nextProps.showLoadingPlaceholder &&
      prevProps.onLoad === nextProps.onLoad &&
      prevProps.alt === nextProps.alt
    );
  },
);

// Image identity owns all loading, error, fullscreen, and blob state. A new
// result must never inherit the previous result's decoded URL. Stabilizing the
// reference also keeps presentation-only changes from releasing a live blob.
export const OptimizedImage = memo(function OptimizedImage(
  props: OptimizedImageProps,
) {
  const { imageId, sessionId, userId, mimeType, url } = props.imageRef ?? {};
  const imageRef = useMemo(
    () =>
      imageId !== undefined && sessionId !== undefined
        ? { imageId, sessionId, userId, mimeType, url }
        : undefined,
    [imageId, sessionId, userId, mimeType, url],
  );
  const identity = imageRef
    ? JSON.stringify([imageId, sessionId, userId, props.useThumbnail ?? true])
    : 'inline';
  return <ImageView {...props} imageRef={imageRef} key={identity} />;
});

ImageView.displayName = 'ImageView';
OptimizedImage.displayName = 'OptimizedImage';
