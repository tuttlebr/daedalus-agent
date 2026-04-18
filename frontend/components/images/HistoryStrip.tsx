'use client';

import React from 'react';
import classNames from 'classnames';
import { Tooltip } from '@/components/primitives';
import { OptimizedImage } from '@/components/chat/OptimizedImage';
import type { HistoryEntry } from '@/state/imagePanelStore';

interface HistoryStripProps {
  history: HistoryEntry[];
  onRestore: (entryId: string) => void;
}

export function HistoryStrip({ history, onRestore }: HistoryStripProps) {
  if (history.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        Session history ({history.length})
      </label>
      <div className="flex gap-2 overflow-x-auto pb-2">
        {history.map((entry) => (
          <Tooltip key={entry.id} content={entry.prompt.slice(0, 200)} position="top">
            <button
              type="button"
              onClick={() => onRestore(entry.id)}
              className={classNames(
                'flex-shrink-0 flex items-center gap-2 rounded-lg',
                'bg-neutral-100 dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800',
                'hover:ring-nvidia-green/60 transition-all',
                'p-1.5',
              )}
            >
              <div className="w-14 h-14 rounded-md overflow-hidden bg-neutral-200 dark:bg-neutral-800">
                {entry.outputImageIds[0] && (
                  <OptimizedImage
                    imageRef={{
                      imageId: entry.outputImageIds[0],
                      sessionId: 'generated',
                      mimeType: 'image/png',
                    }}
                    alt=""
                    useThumbnail
                    className="w-full h-full object-cover"
                  />
                )}
              </div>
              <div className="flex flex-col items-start max-w-[140px]">
                <span className="text-[10px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  {entry.mode}
                </span>
                <span className="text-xs text-neutral-900 dark:text-neutral-100 truncate w-full">
                  {entry.prompt.slice(0, 40) || '(no prompt)'}
                </span>
                <span className="text-[10px] text-neutral-500">
                  {entry.outputImageIds.length} image
                  {entry.outputImageIds.length !== 1 ? 's' : ''}
                </span>
              </div>
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
