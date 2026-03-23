import React, { FC } from 'react';
import { IconX, IconPhoto, IconVideo, IconFile } from '@tabler/icons-react';

export interface UploadItem {
  filename: string;
  progress: number;
  type: 'image' | 'video' | 'document';
}

interface UploadProgressBarProps {
  uploads: Record<string, UploadItem>;
  onCancel: (id: string) => void;
}

const typeIcon = (type: UploadItem['type']) => {
  switch (type) {
    case 'image':
      return <IconPhoto size={14} />;
    case 'video':
      return <IconVideo size={14} />;
    default:
      return <IconFile size={14} />;
  }
};

export const UploadProgressBar: FC<UploadProgressBarProps> = ({ uploads, onCancel }) => {
  const entries = Object.entries(uploads);
  if (entries.length === 0) return null;

  const avgProgress = Math.round(
    entries.reduce((sum, [, u]) => sum + u.progress, 0) / entries.length,
  );

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2 border-t border-neutral-200 dark:border-neutral-700 bg-white/50 dark:bg-neutral-900/50 backdrop-blur-sm">
      <div className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
        Uploading {entries.length} file{entries.length > 1 ? 's' : ''}… {avgProgress}%
      </div>
      <div className="flex flex-wrap gap-2">
        {entries.map(([id, upload]) => (
          <div
            key={id}
            className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800 px-2.5 py-1 text-xs"
          >
            {typeIcon(upload.type)}
            <span className="max-w-[100px] truncate text-neutral-700 dark:text-neutral-300">
              {upload.filename}
            </span>
            <div className="relative h-1 w-16 rounded-full bg-neutral-300 dark:bg-neutral-600 overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-nvidia-green transition-all duration-300"
                style={{ width: `${upload.progress}%` }}
              />
            </div>
            <button
              onClick={() => onCancel(id)}
              className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors"
              aria-label={`Cancel upload of ${upload.filename}`}
            >
              <IconX size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
