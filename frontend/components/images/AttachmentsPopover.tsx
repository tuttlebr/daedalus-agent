'use client';

import { IconPaperclip, IconX } from '@tabler/icons-react';
import React, { memo, useCallback, useRef, useState } from 'react';

import { uploadImage } from '@/utils/app/imageHandler';

import { OptimizedImage } from '@/components/chat/OptimizedImage';
import { IconButton, Popover } from '@/components/primitives';

import { DockIconTrigger } from './PresetsPopover';

import { useImagePanelStore, type ImageRef } from '@/state/imagePanelStore';
import classNames from 'classnames';

const MAX_INPUTS = 16;

interface LocalImageMetadata {
  width?: number;
  height?: number;
  hasAlpha?: boolean;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function readImageFileMetadata(file: File): Promise<LocalImageMetadata> {
  if (typeof window === 'undefined') return {};

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Unable to read image'));
      image.src = url;
    });

    const width = img.naturalWidth;
    const height = img.naturalHeight;
    let hasAlpha: boolean | undefined =
      file.type === 'image/png' || file.type === 'image/webp'
        ? undefined
        : false;

    if (file.type === 'image/png' || file.type === 'image/webp') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        hasAlpha = false;
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, width, height).data;
        const pixelCount = width * height;
        const step = Math.max(1, Math.floor(pixelCount / 50_000));
        for (let pixel = 0; pixel < pixelCount; pixel += step) {
          if (data[pixel * 4 + 3] < 255) {
            hasAlpha = true;
            break;
          }
        }
      }
    }

    return { width, height, hasAlpha };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function safeReadImageFileMetadata(
  file: File,
): Promise<LocalImageMetadata> {
  try {
    return await readImageFileMetadata(file);
  } catch {
    return {};
  }
}

async function ingest(
  file: File,
  metadata: LocalImageMetadata = {},
): Promise<ImageRef> {
  const base64 = await fileToBase64(file);
  const r = await uploadImage(base64, file.type || 'image/png');
  return {
    imageId: r.imageId,
    sessionId: r.sessionId ?? '',
    userId: r.userId,
    mimeType: r.mimeType,
    width: metadata.width,
    height: metadata.height,
    hasAlpha: metadata.hasAlpha,
  };
}

interface AttachmentsPopoverProps {
  disabled?: boolean;
  triggerClassName?: string;
}

export const AttachmentsPopover = memo(function AttachmentsPopover({
  disabled,
  triggerClassName,
}: AttachmentsPopoverProps) {
  const inputImages = useImagePanelStore((s) => s.inputImages);
  const maskImage = useImagePanelStore((s) => s.maskImage);

  const attachedCount = inputImages.length + (maskImage ? 1 : 0);

  return (
    <Popover
      position="top"
      align="start"
      sheetOnMobile
      trigger={
        <DockIconTrigger
          disabled={disabled}
          aria-label="Edit assets"
          className={triggerClassName}
        >
          <div className="relative">
            <IconPaperclip size={16} />
            {attachedCount > 0 && (
              <span className="absolute -top-1 -right-2 min-w-[14px] h-[14px] px-1 rounded-full bg-nvidia-green text-black text-[9px] font-bold flex items-center justify-center">
                {attachedCount}
              </span>
            )}
          </div>
        </DockIconTrigger>
      }
    >
      <div className="w-full md:w-96">
        <EditAssetsPanel layout="popover" disabled={disabled} />
      </div>
    </Popover>
  );
});

export function EditAssetsPanel({
  disabled,
  layout = 'panel',
}: {
  disabled?: boolean;
  layout?: 'panel' | 'popover';
}) {
  const inputImages = useImagePanelStore((s) => s.inputImages);
  const addInputImages = useImagePanelStore((s) => s.addInputImages);
  const removeInputImage = useImagePanelStore((s) => s.removeInputImage);
  const clearInputImages = useImagePanelStore((s) => s.clearInputImages);
  const maskImage = useImagePanelStore((s) => s.maskImage);
  const setMaskImage = useImagePanelStore((s) => s.setMaskImage);

  return (
    <div
      className={classNames(
        layout === 'panel'
          ? 'grid gap-4 border-b border-white/5 bg-neutral-950/80 p-3 md:grid-cols-[minmax(0,1fr)_260px]'
          : 'p-4',
      )}
    >
      <InputsSection
        images={inputImages}
        onAdd={addInputImages}
        onRemove={removeInputImage}
        onClear={clearInputImages}
        disabled={disabled}
        layout={layout}
      />
      <div
        className={classNames(
          layout === 'panel'
            ? 'border-t border-white/5 pt-4 md:border-l md:border-t-0 md:pl-4 md:pt-0'
            : 'mt-4 border-t border-white/5 pt-4',
        )}
      >
        <MaskSection
          firstImage={inputImages[0] ?? null}
          mask={maskImage}
          onChange={setMaskImage}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

function InputsSection({
  images,
  onAdd,
  onRemove,
  onClear,
  disabled,
  layout,
}: {
  images: ImageRef[];
  onAdd: (refs: ImageRef[]) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  disabled?: boolean;
  layout: 'panel' | 'popover';
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setError(null);
      const remaining = Math.max(0, MAX_INPUTS - images.length);
      const accepted = Array.from(files).slice(0, remaining);
      if (accepted.length === 0) {
        setError(`Maximum ${MAX_INPUTS} images`);
        return;
      }
      setUploading(true);
      try {
        const refs = await Promise.all(
          accepted.map(async (file) =>
            ingest(file, await safeReadImageFileMetadata(file)),
          ),
        );
        onAdd(refs);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    },
    [images.length, onAdd],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-neutral-500">
          Input images {images.length > 0 && `(${images.length})`}
        </div>
        {images.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-[10px] uppercase tracking-wider text-neutral-500 hover:text-neutral-100 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {images.length > 0 && (
        <div
          className={classNames(
            'mb-2 grid gap-1.5',
            layout === 'panel'
              ? 'grid-cols-4 sm:grid-cols-6 lg:grid-cols-8'
              : 'grid-cols-3 md:grid-cols-4',
          )}
        >
          {images.map((ref, idx) => (
            <Thumb
              key={ref.imageId}
              index={idx + 1}
              imageRef={ref}
              onRemove={() => onRemove(ref.imageId)}
            />
          ))}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => handleFiles(e.target.files)}
        disabled={disabled}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled || uploading || images.length >= MAX_INPUTS}
        className={classNames(
          'w-full py-2 rounded-md text-xs',
          'border border-dashed border-white/10',
          'text-neutral-400 hover:text-neutral-100 hover:border-white/20 hover:bg-white/5',
          'transition-colors',
          (disabled || uploading || images.length >= MAX_INPUTS) &&
            'opacity-40 cursor-not-allowed',
        )}
      >
        {uploading
          ? 'Uploading…'
          : images.length >= MAX_INPUTS
          ? `Maximum ${MAX_INPUTS} images`
          : '+ Add images'}
      </button>
      <p className="text-[10px] text-neutral-500 mt-2 leading-relaxed">
        Reference uploaded images in your prompt as Image&nbsp;1, Image&nbsp;2,
        …
      </p>

      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}

function MaskSection({
  firstImage,
  mask,
  onChange,
  disabled,
}: {
  firstImage: ImageRef | null;
  mask: ImageRef | null;
  onChange: (ref: ImageRef | null) => void;
  disabled?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      setError(null);
      setUploading(true);
      try {
        const metadata = await readImageFileMetadata(file);
        if (file.type !== 'image/png') {
          throw new Error('Use a PNG mask with transparent pixels.');
        }
        if (metadata.hasAlpha === false) {
          throw new Error('Mask must include transparent pixels.');
        }
        if (
          firstImage?.width &&
          firstImage.height &&
          metadata.width &&
          metadata.height &&
          (firstImage.width !== metadata.width ||
            firstImage.height !== metadata.height)
        ) {
          throw new Error(
            `Mask must match Image 1 dimensions (${firstImage.width}x${firstImage.height}).`,
          );
        }
        const ref = await ingest(file, metadata);
        onChange(ref);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    },
    [firstImage, onChange],
  );

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
        Mask for Image 1 (optional)
      </div>
      {mask ? (
        <div>
          <div className="relative group w-24 h-24 rounded-md overflow-hidden bg-neutral-900 ring-1 ring-white/10">
            <OptimizedImage
              imageRef={{
                imageId: mask.imageId,
                sessionId: mask.sessionId,
                mimeType: mask.mimeType ?? 'image/png',
              }}
              alt="Mask for Image 1"
              useThumbnail
              className="w-full h-full object-contain"
            />
            <div className="absolute top-1 right-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
              <IconButton
                icon={<IconX size={12} />}
                onClick={() => onChange(null)}
                variant="danger"
                size="xs"
                aria-label="Remove mask"
              />
            </div>
          </div>
          {firstImage && <MaskOverlayPreview image={firstImage} mask={mask} />}
        </div>
      ) : (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => handleFiles(e.target.files)}
            disabled={disabled || !firstImage}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || uploading || !firstImage}
            className={classNames(
              'w-full py-2 rounded-md text-xs',
              'border border-dashed border-white/10',
              'text-neutral-400 hover:text-neutral-100 hover:border-white/20 hover:bg-white/5',
              'transition-colors',
              (disabled || uploading || !firstImage) &&
                'opacity-40 cursor-not-allowed',
            )}
          >
            {!firstImage
              ? 'Add Image 1 first'
              : uploading
              ? 'Uploading…'
              : '+ Add mask'}
          </button>
          <p className="text-[10px] text-neutral-500 mt-2 leading-relaxed">
            Transparent PNG, same dimensions as Image 1. Transparent areas guide
            the edit.
          </p>
        </>
      )}
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}

function MaskOverlayPreview({
  image,
  mask,
}: {
  image: ImageRef;
  mask: ImageRef;
}) {
  return (
    <div className="mt-2">
      <div className="relative h-24 w-24 overflow-hidden rounded-md bg-neutral-900 ring-1 ring-white/10">
        <OptimizedImage
          imageRef={{
            imageId: image.imageId,
            sessionId: image.sessionId,
            mimeType: image.mimeType ?? 'image/png',
          }}
          alt="Image 1 mask preview"
          useThumbnail
          className="h-full w-full object-cover"
        />
        <OptimizedImage
          imageRef={{
            imageId: mask.imageId,
            sessionId: mask.sessionId,
            mimeType: mask.mimeType ?? 'image/png',
          }}
          alt=""
          useThumbnail
          className="absolute inset-0 h-full w-full object-cover opacity-50 mix-blend-screen"
        />
      </div>
      <p className="mt-1 text-[10px] leading-snug text-neutral-500">
        Mask applies to Image 1.
      </p>
    </div>
  );
}

function Thumb({
  index,
  imageRef,
  onRemove,
}: {
  index: number;
  imageRef: ImageRef;
  onRemove: () => void;
}) {
  return (
    <div className="relative group aspect-square rounded-md overflow-hidden bg-neutral-900 ring-1 ring-white/10">
      <OptimizedImage
        imageRef={{
          imageId: imageRef.imageId,
          sessionId: imageRef.sessionId,
          mimeType: imageRef.mimeType ?? 'image/png',
        }}
        alt={`Image ${index}`}
        useThumbnail
        className="w-full h-full object-cover"
      />
      <div className="absolute inset-x-0 top-0 px-1.5 py-0.5 bg-black/60 text-white text-[9px] font-medium">
        {index}
      </div>
      <div className="absolute top-0.5 right-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
        <IconButton
          icon={<IconX size={10} />}
          onClick={onRemove}
          variant="danger"
          size="xs"
          aria-label={`Remove image ${index}`}
        />
      </div>
    </div>
  );
}
