import type { GalleryImage } from '@/state/imagePanelStore';

export function ImagePromptDetail({ image }: { image: GalleryImage }) {
  return (
    <div className="my-3 space-y-2 text-sm text-secondary">
      <p className="whitespace-pre-wrap">
        {image.imageContext?.originalPrompt ?? image.prompt}
      </p>
      {image.imageContext?.warning && (
        <p role="status" className="text-xs text-amber-300">
          {image.imageContext.warning}
        </p>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer py-2 text-muted">
          Prompt used
        </summary>
        <p className="whitespace-pre-wrap break-words">
          {image.imageContext?.prompt ?? image.prompt}
        </p>
      </details>
    </div>
  );
}
