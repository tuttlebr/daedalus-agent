import React, { memo, useMemo, useRef, useState, useCallback } from "react";
import Loading from "./Loading";
import { IconExclamationCircle, IconDownload } from "@tabler/icons-react";
import { OptimizedImage } from "@/components/Chat/OptimizedImage";

interface ImageProps {
  src?: string;
  alt?: string;
  [key: string]: any;
}

export const Image = memo(({ src, alt, ...props }: ImageProps) => {
  const imgRef = useRef(null);
  const [error, setError] = useState(false);

  // Check if the src is from our image storage API (Redis-backed)
  const isStorageApiUrl = useMemo(() => {
    return typeof src === 'string' && src.includes('/api/session/imageStorage');
  }, [src]);

  // Parse imageRef from storage API URL
  const imageRef = useMemo(() => {
    if (isStorageApiUrl && src) {
      try {
        const url = new URL(src, window.location.origin);
        const imageId = url.searchParams.get('imageId');
        const sessionId = url.searchParams.get('sessionId');
        if (imageId && sessionId) {
          console.log('Image.tsx: Detected storage URL, parsed imageRef:', { imageId, sessionId });
          return { imageId, sessionId };
        }
      } catch (err) {
        console.error('Image.tsx: Failed to parse image storage URL:', err);
      }
    }
    return null;
  }, [src, isStorageApiUrl]);

  const handleImageError = () => {
    console.error(`Image failed to load: ${src}`);
    setError(true);
  };

  const handleDownload = useCallback(async () => {
    if (!src) return;

    try {
      // Fetch the image as a blob
      const response = await fetch(src);
      const blob = await response.blob();

      const fileName = alt ? `${alt}.png` : `image-${Date.now()}.png`;

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
  }, [src, alt]);

  const imageElement = useMemo(() => {
    if (src === "loading") {
      return <Loading message="Loading..." type="image" />;
    }

    // Use OptimizedImage component for images stored in Redis
    if (imageRef) {
      return <OptimizedImage imageRef={imageRef} alt={alt || "Generated image"} />;
    }

    // Regular image display (external URLs, base64, etc.)
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
  }, [src, alt, error, imageRef, handleDownload]);

  return imageElement;
}, (prevProps: ImageProps, nextProps: ImageProps) => {
  const areEqual = prevProps.src === nextProps.src;

  // Debug: log when src changes
  if (!areEqual) {
    console.log('Image component: src changed, will re-render', {
      prevSrc: prevProps.src?.substring(0, 100),
      nextSrc: nextProps.src?.substring(0, 100),
      prevIsStorage: prevProps.src?.includes('/api/session/imageStorage'),
      nextIsStorage: nextProps.src?.includes('/api/session/imageStorage'),
    });
  }

  return areEqual;
});
