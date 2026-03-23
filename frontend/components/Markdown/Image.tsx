import React, { memo, useMemo, useRef, useState, useCallback, useEffect } from "react";
import Loading from "./Loading";
import { IconExclamationCircle, IconDownload } from "@tabler/icons-react";
import { OptimizedImage } from "@/components/Chat/OptimizedImage";
import { uploadImage, ImageReference } from "@/utils/app/imageHandler";

interface ImageProps {
  src?: string;
  alt?: string;
  [key: string]: any;
}

// Track images currently being uploaded to prevent duplicates
const uploadingImages = new Set<string>();

export const Image = memo(({ src, alt, ...props }: ImageProps) => {
  const imgRef = useRef(null);
  const [error, setError] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadedRef, setUploadedRef] = useState<ImageReference | null>(null);

  // Check if the src is from our image storage API (Redis-backed)
  const isStorageApiUrl = useMemo(() => {
    return typeof src === 'string' && src.includes('/api/session/imageStorage');
  }, [src]);

  // Check if the src is from the generated-image API (backend tool output)
  const isGeneratedImageUrl = useMemo(() => {
    return typeof src === 'string' && /\/api\/generated-image\/[a-f0-9-]+/.test(src);
  }, [src]);

  // Check if src is a base64 data URL
  const isBase64DataUrl = useMemo(() => {
    return typeof src === 'string' && src.startsWith('data:image/') && src.includes('base64,');
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
        console.error('Image.tsx: Failed to parse image storage URL:', err);
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
    if (!isBase64DataUrl || !src || uploadedRef || isUploading) return;

    // Create a hash of the first 100 chars to identify this image
    const imageKey = src.substring(0, 100);
    if (uploadingImages.has(imageKey)) {
      return; // Already uploading this image
    }

    const uploadToStorage = async () => {
      uploadingImages.add(imageKey);
      setIsUploading(true);

      try {
        // Extract mime type from data URL
        const mimeTypeMatch = src.match(/data:(image\/[a-zA-Z0-9+.-]+);base64,/);
        const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : 'image/png';

        console.log('Image.tsx: Uploading base64 image to Redis storage...');
        const ref = await uploadImage(src, mimeType);
        console.log('Image.tsx: Upload complete, imageId:', ref.imageId);

        setUploadedRef(ref);
      } catch (err) {
        console.error('Image.tsx: Failed to upload base64 image:', err);
        // Fall back to displaying original base64 (not ideal but works)
      } finally {
        setIsUploading(false);
        uploadingImages.delete(imageKey);
      }
    };

    uploadToStorage();
  }, [src, isBase64DataUrl, uploadedRef, isUploading]);

  const handleImageError = () => {
    console.error(`Image failed to load: ${src?.substring(0, 100)}...`);
    setError(true);
  };

  const handleDownload = useCallback(async () => {
    // For downloaded images, use full quality (not thumbnail)
    const downloadSrc = uploadedRef
      ? `/api/session/imageStorage?imageId=${uploadedRef.imageId}&sessionId=${uploadedRef.sessionId}`
      : src;

    if (!downloadSrc) return;

    try {
      // Fetch the image as a blob
      const response = await fetch(downloadSrc);
      const blob = await response.blob();

      const fileName = alt ? `${alt}.png` : `image-${Date.now()}.png`;

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
  }, [src, alt, uploadedRef]);

  const imageElement = useMemo(() => {
    if (src === "loading" || isUploading) {
      return <Loading message={isUploading ? "Optimizing image..." : "Loading..."} type="image" />;
    }

    // Use OptimizedImage for uploaded base64 images
    if (uploadedRef) {
      return <OptimizedImage imageRef={uploadedRef} alt={alt || "Generated image"} />;
    }

    // Use OptimizedImage component for images stored in Redis
    if (imageRef) {
      return <OptimizedImage imageRef={imageRef} alt={alt || "Generated image"} />;
    }

    // Show loading if we're about to upload a base64 image
    if (isBase64DataUrl && !error) {
      return <Loading message="Optimizing image..." type="image" />;
    }

    // Regular image display (external URLs only - base64 should be uploaded first)
    return (
      <>
        {/* Image Container */}
        <div className="relative group">
          {error ? (
            <div className="flex items-center justify-center p-4 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
              <IconExclamationCircle className="w-5 h-5 text-red-500 mr-2" />
              <p className="text-red-600 dark:text-red-400 text-sm">
                Failed to load image
              </p>
            </div>
          ) : (
            <div className="relative">
              {/* Image */}
              <img
                ref={imgRef}
                src={src}
                alt={alt || "image"}
                onError={handleImageError}
                className="object-cover rounded-lg border border-slate-100 dark:border-gray-700 shadow-xs max-w-full h-auto"
                loading="lazy"
                decoding="async"
                {...props}
              />
              {/* Download button overlay */}
              <button
                className="absolute top-2 right-2 bg-black/50 hover:bg-black/70 text-white p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 sm:opacity-100"
                onClick={handleDownload}
                aria-label="Download image"
                title="Download as PNG"
              >
                <IconDownload size={20} />
              </button>
            </div>
          )}
        </div>
      </>
    );
  }, [src, alt, error, imageRef, uploadedRef, isUploading, isBase64DataUrl, handleDownload]);

  return imageElement;
}, (prevProps: ImageProps, nextProps: ImageProps) => {
  // Only re-render if src changes
  return prevProps.src === nextProps.src;
});
