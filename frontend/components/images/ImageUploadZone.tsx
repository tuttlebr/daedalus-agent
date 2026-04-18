'use client';

import React, { useCallback, useState } from 'react';
import classNames from 'classnames';
import { IconPhotoPlus, IconX } from '@tabler/icons-react';
import { DropZone, IconButton } from '@/components/primitives';
import { OptimizedImage } from '@/components/chat/OptimizedImage';
import { uploadImage } from '@/utils/app/imageHandler';
import type { ImageRef } from '@/state/imagePanelStore';

interface ImageUploadZoneProps {
  images: ImageRef[];
  onAdd: (refs: ImageRef[]) => void;
  onRemove: (imageId: string) => void;
  label?: string;
  hint?: string;
  maxImages?: number;
  disabled?: boolean;
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

export function ImageUploadZone({
  images,
  onAdd,
  onRemove,
  label = 'Input images',
  hint = 'Drop or click to upload. They appear as Image 1, Image 2, … in the prompt.',
  maxImages = 16,
  disabled,
}: ImageUploadZoneProps) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleDrop = useCallback(
    async (files: File[]) => {
      setUploadError(null);
      if (files.length === 0) return;

      const remaining = Math.max(0, maxImages - images.length);
      const accepted = files.slice(0, remaining);
      if (accepted.length === 0) {
        setUploadError(`Maximum ${maxImages} images`);
        return;
      }

      setUploading(true);
      try {
        const refs = await Promise.all(
          accepted.map(async (file) => {
            const base64 = await fileToBase64(file);
            return uploadImage(base64, file.type || 'image/png');
          }),
        );
        onAdd(
          refs.map((r) => ({
            imageId: r.imageId,
            sessionId: r.sessionId ?? '',
            userId: r.userId,
            mimeType: r.mimeType,
          })),
        );
      } catch (e) {
        console.error('Upload failed', e);
        setUploadError(e instanceof Error ? e.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    },
    [images.length, maxImages, onAdd],
  );

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        {label}
      </label>
      <p className="text-[11px] text-neutral-500 dark:text-neutral-500">{hint}</p>

      <DropZone onDrop={handleDrop} accept="image/*" multiple disabled={disabled}>
        <div
          className={classNames(
            'rounded-xl border-2 border-dashed transition-colors',
            'border-neutral-300 dark:border-neutral-700',
            'bg-neutral-50 dark:bg-neutral-900/40',
            'hover:border-nvidia-green/60 hover:bg-nvidia-green/5',
            'p-4',
          )}
        >
          {images.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {images.map((ref, idx) => (
                <Thumbnail
                  key={ref.imageId}
                  index={idx + 1}
                  imageId={ref.imageId}
                  sessionId={ref.sessionId}
                  mimeType={ref.mimeType}
                  onRemove={() => onRemove(ref.imageId)}
                />
              ))}
              <AddMoreTile
                disabled={disabled || uploading || images.length >= maxImages}
                uploading={uploading}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-neutral-500 dark:text-neutral-400">
              <IconPhotoPlus size={32} />
              <span className="text-sm">
                {uploading ? 'Uploading…' : 'Drop images here, or click to select'}
              </span>
            </div>
          )}
        </div>
      </DropZone>

      {uploadError && (
        <p className="text-xs text-red-500 dark:text-red-400">{uploadError}</p>
      )}
    </div>
  );
}

function Thumbnail({
  index,
  imageId,
  sessionId,
  mimeType,
  onRemove,
}: {
  index: number;
  imageId: string;
  sessionId: string;
  mimeType?: string;
  onRemove: () => void;
}) {
  return (
    <div className="relative group aspect-square rounded-lg overflow-hidden bg-neutral-200 dark:bg-neutral-800">
      <OptimizedImage
        imageRef={{ imageId, sessionId, mimeType: mimeType ?? 'image/png' }}
        alt={`Image ${index}`}
        useThumbnail
        className="w-full h-full object-cover"
      />
      <div className="absolute top-1 left-1 px-2 py-0.5 rounded-md bg-black/70 text-white text-[11px] font-medium">
        Image {index}
      </div>
      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <IconButton
          icon={<IconX size={14} />}
          onClick={onRemove}
          variant="danger"
          size="xs"
          aria-label={`Remove image ${index}`}
        />
      </div>
    </div>
  );
}

function AddMoreTile({
  disabled,
  uploading,
}: {
  disabled: boolean;
  uploading: boolean;
}) {
  return (
    <div
      className={classNames(
        'aspect-square rounded-lg border-2 border-dashed',
        'flex items-center justify-center gap-1',
        'border-neutral-300 dark:border-neutral-700',
        'text-neutral-500 dark:text-neutral-400 text-xs',
        disabled && 'opacity-40',
      )}
    >
      {uploading ? 'Uploading…' : '+ Add more'}
    </div>
  );
}
