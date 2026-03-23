'use client';

import React, { memo, useState } from 'react';
import Image, { ImageProps } from 'next/image';
import classNames from 'classnames';

// =============================================================================
// NEXT IMAGE WRAPPER
// Wrapper around next/image with additional features like loading states,
// error handling, and consistent styling.
// =============================================================================

interface NextImageProps extends Omit<ImageProps, 'onError' | 'onLoad'> {
  fallbackSrc?: string;
  showLoadingState?: boolean;
  containerClassName?: string;
}

/**
 * NextImage - Optimized image component using next/image
 *
 * Use this for:
 * - Static images (logos, icons, backgrounds)
 * - External images from known domains
 * - Images that benefit from next/image optimization (WebP/AVIF, responsive srcset)
 *
 * For Redis-backed dynamic images, use OptimizedImage instead.
 */
export const NextImage = memo(({
  src,
  alt,
  fallbackSrc,
  showLoadingState = true,
  containerClassName = '',
  className = '',
  priority = false,
  ...props
}: NextImageProps) => {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [currentSrc, setCurrentSrc] = useState(src);

  const handleLoad = () => {
    setIsLoading(false);
    setHasError(false);
  };

  const handleError = () => {
    setIsLoading(false);
    setHasError(true);

    // Try fallback if available
    if (fallbackSrc && currentSrc !== fallbackSrc) {
      setCurrentSrc(fallbackSrc);
      setHasError(false);
      setIsLoading(true);
    }
  };

  return (
    <div className={classNames('relative overflow-hidden', containerClassName)}>
      {/* Loading skeleton */}
      {showLoadingState && isLoading && !hasError && (
        <div className="absolute inset-0 bg-neutral-200/60 dark:bg-neutral-800/60 animate-pulse" />
      )}

      {/* Error state */}
      {hasError && !fallbackSrc && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-100 dark:bg-neutral-800">
          <svg
            className="w-8 h-8 text-neutral-400 dark:text-neutral-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
        </div>
      )}

      {/* Actual image */}
      {!hasError && (
        <Image
          src={currentSrc}
          alt={alt}
          className={classNames(
            'transition-opacity duration-300',
            isLoading ? 'opacity-0' : 'opacity-100',
            className
          )}
          onLoad={handleLoad}
          onError={handleError}
          priority={priority}
          {...props}
        />
      )}
    </div>
  );
});

NextImage.displayName = 'NextImage';

// =============================================================================
// AVATAR IMAGE
// Specialized image component for user/bot avatars with circular styling
// =============================================================================

interface AvatarImageProps {
  src: string;
  alt?: string;
  size?: number | 'sm' | 'md' | 'lg' | 'xl';
  fallbackSrc?: string;
  className?: string;
  priority?: boolean;
}

const sizeMap = {
  sm: 24,
  md: 32,
  lg: 40,
  xl: 48,
};

export const AvatarImage = memo(({
  src,
  alt = 'Avatar',
  size = 'md',
  fallbackSrc = '/default-avatar.png',
  className = '',
  priority = false,
}: AvatarImageProps) => {
  const pixelSize = typeof size === 'number' ? size : sizeMap[size];

  return (
    <NextImage
      src={src}
      alt={alt}
      width={pixelSize}
      height={pixelSize}
      fallbackSrc={fallbackSrc}
      priority={priority}
      containerClassName={classNames(
        'rounded-full flex-shrink-0',
        className
      )}
      className="rounded-full object-cover"
    />
  );
});

AvatarImage.displayName = 'AvatarImage';

// =============================================================================
// BACKGROUND IMAGE
// Full-cover background image with blur-up loading effect
// =============================================================================

interface BackgroundImageProps {
  src: string;
  alt?: string;
  className?: string;
  priority?: boolean;
  overlay?: boolean;
  overlayOpacity?: number;
}

export const BackgroundImage = memo(({
  src,
  alt = 'Background',
  className = '',
  priority = false,
  overlay = false,
  overlayOpacity = 0.5,
}: BackgroundImageProps) => {
  return (
    <div className={classNames('relative overflow-hidden', className)}>
      <NextImage
        src={src}
        alt={alt}
        fill
        priority={priority}
        showLoadingState={true}
        className="object-cover"
        sizes="100vw"
      />
      {overlay && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{ opacity: overlayOpacity }}
        />
      )}
    </div>
  );
});

BackgroundImage.displayName = 'BackgroundImage';

export default NextImage;
