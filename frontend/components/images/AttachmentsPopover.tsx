'use client';

import React, { useCallback, useRef, useState } from 'react';
import classNames from 'classnames';
import { IconPaperclip, IconX } from '@tabler/icons-react';
import { IconButton, Popover } from '@/components/primitives';
import { OptimizedImage } from '@/components/chat/OptimizedImage';
import { uploadImage } from '@/utils/app/imageHandler';
import {
  useImagePanelStore,
  type ImageRef,
} from '@/state/imagePanelStore';
import { DockIconTrigger } from './PresetsPopover';

const MAX_INPUTS = 16;

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

async function ingest(file: File): Promise<ImageRef> {
  const base64 = await fileToBase64(file);
  const r = await uploadImage(base64, file.type || 'image/png');
  return {
    imageId: r.imageId,
    sessionId: r.sessionId ?? '',
    userId: r.userId,
    mimeType: r.mimeType,
  };
}

interface AttachmentsPopoverProps {
  disabled?: boolean;
}

export function AttachmentsPopover({ disabled }: AttachmentsPopoverProps) {
  const inputImages = useImagePanelStore((s) => s.inputImages);
  const addInputImages = useImagePanelStore((s) => s.addInputImages);
  const removeInputImage = useImagePanelStore((s) => s.removeInputImage);
  const clearInputImages = useImagePanelStore((s) => s.clearInputImages);
  const maskImage = useImagePanelStore((s) => s.maskImage);
  const setMaskImage = useImagePanelStore((s) => s.setMaskImage);

  const attachedCount = inputImages.length + (maskImage ? 1 : 0);

  return (
    <Popover
      position="top"
      align="start"
      trigger={
        <DockIconTrigger disabled={disabled} aria-label="Attachments">
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
      <div className="p-4 w-80">
        <InputsSection
          images={inputImages}
          onAdd={addInputImages}
          onRemove={removeInputImage}
          onClear={clearInputImages}
        />
        <div className="mt-4 pt-4 border-t border-white/5">
          <MaskSection mask={maskImage} onChange={setMaskImage} />
        </div>
      </div>
    </Popover>
  );
}

function InputsSection({
  images,
  onAdd,
  onRemove,
  onClear,
}: {
  images: ImageRef[];
  onAdd: (refs: ImageRef[]) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
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
        const refs = await Promise.all(accepted.map(ingest));
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
        <div className="grid grid-cols-4 gap-1.5 mb-2">
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
        className="hidden"
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading || images.length >= MAX_INPUTS}
        className={classNames(
          'w-full py-2 rounded-md text-xs',
          'border border-dashed border-white/10',
          'text-neutral-400 hover:text-neutral-100 hover:border-white/20 hover:bg-white/5',
          'transition-colors',
          (uploading || images.length >= MAX_INPUTS) &&
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
        Reference uploaded images in your prompt as Image&nbsp;1, Image&nbsp;2, …
      </p>

      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}

function MaskSection({
  mask,
  onChange,
}: {
  mask: ImageRef | null;
  onChange: (ref: ImageRef | null) => void;
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
        const ref = await ingest(file);
        onChange(ref);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    },
    [onChange],
  );

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
        Mask (optional, inpainting)
      </div>
      {mask ? (
        <div className="relative group w-24 h-24 rounded-md overflow-hidden bg-neutral-900 ring-1 ring-white/10">
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
          <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <IconButton
              icon={<IconX size={12} />}
              onClick={() => onChange(null)}
              variant="danger"
              size="xs"
              aria-label="Remove mask"
            />
          </div>
        </div>
      ) : (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => handleFiles(e.target.files)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className={classNames(
              'w-full py-2 rounded-md text-xs',
              'border border-dashed border-white/10',
              'text-neutral-400 hover:text-neutral-100 hover:border-white/20 hover:bg-white/5',
              'transition-colors',
              uploading && 'opacity-40',
            )}
          >
            {uploading ? 'Uploading…' : '+ Add mask'}
          </button>
          <p className="text-[10px] text-neutral-500 mt-2 leading-relaxed">
            Transparent PNG. Only transparent pixels get edited.
          </p>
        </>
      )}
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
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
      <div className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
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
