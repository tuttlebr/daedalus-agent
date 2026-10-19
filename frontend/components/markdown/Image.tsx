import { IconExclamationCircle, IconDownload } from '@tabler/icons-react';
import React, { memo, useMemo, useState, useCallback, useEffect } from 'react';

import { useFileSave } from '@/hooks/useFileSave';

import { uploadImage, ImageReference } from '@/utils/app/imageHandler';
import { Logger } from '@/utils/logger';

import { OptimizedImage } from '@/components/chat/OptimizedImage';

import Loading from './Loading';

const logger = new Logger('Image');

interface ImageProps {
  src?: string;
  alt?: string;
  [key: string]: any;
}

// Track images currently being uploaded to prevent duplicates
const uploadingImages = new Map<string, Promise<ImageReference>>();

const ImageView = memo(({ src, alt, ...props }: ImageProps) => {
  const { saveFile, fileSaveDialog } = useFileSave();
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(false);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadedRef, setUploadedRef] = useState<ImageReference | null>(null);

  // Check if the src is from our image storage API (Redis-backed)
  const isStorageApiUrl = useMemo(() => {
    return typeof src === 'string' && src.includes('/api/session/imageStorage');
  }, [src]);

  // Check if the src is from the generated-image API (backend tool output)
  const isGeneratedImageUrl = useMemo(() => {
    return (
      typeof src === 'string' && /\/api\/generated-image\/[a-f0-9-]+/.test(src)
    );
  }, [src]);

  // Check if src is a base64 data URL
  const isBase64DataUrl = useMemo(() => {
    return (
      typeof src === 'string' &&
      src.startsWith('data:image/') &&
      src.includes('base64,')
    );
  }, [src]);

  // Parse imageRef from storage API URL
  const imageRef = useMemo(() => {
    if (isStorageApiUrl && src) {
      try {
        const url = new URL(src, window.location.origin);
        const imageId = url.searchParams.get('imageId');
        const sessionId = url.searchParams.get('sessionId');
        if (imageId && sessionId) {
          return { imageId, sessionId };
        }
      } catch (err) {
        logger.error('Failed to parse image storage URL:', err);
      }
    }
    // Parse imageId from generated-image URL: /api/generated-image/{uuid}
    if (isGeneratedImageUrl && src) {
      const match = src.match(/\/api\/generated-image\/([a-f0-9-]+)/);
      if (match) {
        return { imageId: match[1], sessionId: 'generated' };
      }
    }
    return null;
  }, [src, isStorageApiUrl, isGeneratedImageUrl]);

  // Auto-upload base64 images to Redis storage
  useEffect(() => {
    if (!isBase64DataUrl || !src) return;
    let cancelled = false;
    setIsUploading(true);
    let pending = uploadingImages.get(src);
    if (!pending) {
      const mimeType =
        src.match(/data:(image\/[a-zA-Z0-9+.-]+);base64,/)?.[1] || 'image/png';
      pending = uploadImage(src, mimeType).finally(() =>
        uploadingImages.delete(src),
      );
      uploadingImages.set(src, pending);
    }
    // Every consumer awaits the same upload; unrelated images must never
    // share work merely because their encoded headers have the same prefix.
    pending.then(
      (ref) => {
        if (cancelled) return;
        setUploadedRef(ref);
        setIsUploading(false);
      },
      (err) => {
        if (cancelled) return;
        logger.error('Failed to upload base64 image:', err);
        setUploadFailed(true);
        setIsUploading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [src, isBase64DataUrl]);

  const handleImageError = () => {
    logger.error(`Image failed to load: ${src?.substring(0, 100)}...`);
    setError(true);
  };

  const handleDownload = useCallback(async () => {
    if (!src || downloading) return;
    setDownloading(true);
    setDownloadError('');
    try {
      const response = await fetch(src);
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
  }, [src, alt, downloading, saveFile]);

  if (src === 'loading' || isUploading) {
    return (
      <Loading
        message={isUploading ? 'Optimizing image...' : 'Loading...'}
        type="image"
      />
    );
  }

  // Use OptimizedImage for uploaded base64 images
  if (uploadedRef) {
    return (
      <OptimizedImage imageRef={uploadedRef} alt={alt || 'Generated image'} />
    );
  }

  // Use OptimizedImage component for images stored in Redis
  if (imageRef) {
    return (
      <OptimizedImage imageRef={imageRef} alt={alt || 'Generated image'} />
    );
  }

  // Show loading if we're about to upload a base64 image
  if (isBase64DataUrl && !uploadFailed) {
    return <Loading message="Optimizing image..." type="image" />;
  }

  // Regular image display (external URLs only - base64 should be uploaded first)
  return (
    <>
      {fileSaveDialog}
      <div className="relative group">
        {error ? (
          <div className="flex items-center justify-center p-4 bg-error dark:bg-error/20 rounded-lg border border-error dark:border-error">
            <IconExclamationCircle className="w-5 h-5 text-primary mr-2" />
            <p className="text-primary text-sm">Failed to load image</p>
          </div>
        ) : (
          <div className="relative">
            <img
              src={src}
              alt={alt || 'image'}
              onError={handleImageError}
              className="object-cover rounded-lg border border-separator shadow-xs max-w-full h-auto"
              loading="lazy"
              decoding="async"
              {...props}
            />
            <button
              className="absolute top-2 right-2 bg-black/50 hover:bg-black/70 text-white p-2 rounded-lg opacity-100 transition-opacity duration-200 touch-action-controls md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
              onClick={handleDownload}
              disabled={downloading}
              aria-busy={downloading}
              aria-label="Download image"
              title="Save image"
            >
              <IconDownload size={20} />
            </button>
          </div>
        )}
      </div>
      {downloadError && (
        <p role="alert" className="text-sm text-primary">
          {downloadError}
        </p>
      )}
    </>
  );
});

// A new source owns fresh loading/error state. Late work from the previous
// source cannot replace it, while presentation-only changes retain the image.
export const Image = (props: ImageProps) => (
  <ImageView key={props.src} {...props} />
);
