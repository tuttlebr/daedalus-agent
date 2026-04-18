'use client';

import React, { useCallback, useState } from 'react';
import classNames from 'classnames';
import { IconMask, IconX } from '@tabler/icons-react';
import { DropZone, IconButton } from '@/components/primitives';
import { OptimizedImage } from '@/components/chat/OptimizedImage';
import { uploadImage } from '@/utils/app/imageHandler';
import type { ImageRef } from '@/state/imagePanelStore';

interface MaskUploadProps {
  mask: ImageRef | null;
  onChange: (mask: ImageRef | null) => void;
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

export function MaskUpload({ mask, onChange, disabled }: MaskUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDrop = useCallback(
    async (files: File[]) => {
      setError(null);
      const file = files[0];
      if (!file) return;

      setUploading(true);
      try {
        const base64 = await fileToBase64(file);
        const ref = await uploadImage(base64, file.type || 'image/png');
        onChange({
          imageId: ref.imageId,
          sessionId: ref.sessionId ?? '',
          userId: ref.userId,
          mimeType: ref.mimeType,
        });
      } catch (e) {
        console.error('Mask upload failed', e);
        setError(e instanceof Error ? e.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    },
    [onChange],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <IconMask size={14} className="text-neutral-500" />
        <label className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          Mask (optional, inpainting)
        </label>
      </div>
      <p className="text-[11px] text-neutral-500 dark:text-neutral-500">
        A pre-made mask PNG (transparent where edits should happen). v2 will add
        a canvas brush tool.
      </p>

      <DropZone onDrop={handleDrop} accept="image/*" multiple={false} disabled={disabled}>
        {mask ? (
          <MaskPreview mask={mask} onRemove={() => onChange(null)} />
        ) : (
          <div
            className={classNames(
              'rounded-xl border-2 border-dashed transition-colors',
              'border-neutral-300 dark:border-neutral-700',
              'bg-neutral-50 dark:bg-neutral-900/40',
              'hover:border-nvidia-green/60 hover:bg-nvidia-green/5',
              'p-4',
              'flex items-center justify-center gap-2 text-sm text-neutral-500 dark:text-neutral-400',
            )}
          >
            {uploading ? 'Uploading…' : 'Drop mask file or click to select'}
          </div>
        )}
      </DropZone>

      {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
    </div>
  );
}

function MaskPreview({ mask, onRemove }: { mask: ImageRef; onRemove: () => void }) {
  return (
    <div className="relative group aspect-video rounded-lg overflow-hidden bg-neutral-200 dark:bg-neutral-800 max-w-xs">
      <OptimizedImage
        imageRef={{
          imageId: mask.imageId,
          sessionId: mask.sessionId,
          mimeType: mask.mimeType ?? 'image/png',
        }}
        alt="Mask"
        useThumbnail
        className="w-full h-full object-contain"
      />
      <div className="absolute top-1 left-1 px-2 py-0.5 rounded-md bg-black/70 text-white text-[11px] font-medium">
        Mask
      </div>
      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <IconButton
          icon={<IconX size={14} />}
          onClick={onRemove}
          variant="danger"
          size="xs"
          aria-label="Remove mask"
        />
      </div>
    </div>
  );
}
