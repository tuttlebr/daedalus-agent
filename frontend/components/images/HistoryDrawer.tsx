'use client';

import React, { useEffect } from 'react';
import classNames from 'classnames';
import { IconHistory, IconX } from '@tabler/icons-react';
import { IconButton } from '@/components/primitives';
import { OptimizedImage } from '@/components/chat/OptimizedImage';
import { useImagePanelStore } from '@/state/imagePanelStore';

export function HistoryToggleButton() {
  const toggleHistory = useImagePanelStore((s) => s.toggleHistory);
  const historyCount = useImagePanelStore((s) => s.history.length);

  return (
    <button
      type="button"
      onClick={toggleHistory}
      className={classNames(
        'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg',
        'text-sm text-neutral-400 hover:text-neutral-100',
        'hover:bg-white/5 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40',
      )}
    >
      <IconHistory size={16} />
      <span>History</span>
      {historyCount > 0 && (
        <span className="text-[10px] text-neutral-500 tabular-nums">
          {historyCount}
        </span>
      )}
    </button>
  );
}

export function HistoryDrawer() {
  const open = useImagePanelStore((s) => s.historyOpen);
  const setHistoryOpen = useImagePanelStore((s) => s.setHistoryOpen);
  const history = useImagePanelStore((s) => s.history);
  const restoreFromHistory = useImagePanelStore((s) => s.restoreFromHistory);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHistoryOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, setHistoryOpen]);

  return (
    <>
      {/* backdrop */}
      <div
        className={classNames(
          'absolute inset-0 bg-black/50 transition-opacity duration-200',
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
        onClick={() => setHistoryOpen(false)}
        aria-hidden
      />

      {/* drawer */}
      <aside
        className={classNames(
          'absolute top-0 right-0 bottom-0 w-full md:w-[360px]',
          'bg-neutral-950/95 backdrop-blur-xl border-l border-white/10',
          'transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full',
          'flex flex-col',
        )}
        role="dialog"
        aria-label="Session history"
      >
        <div className="safe-top flex items-center justify-between px-4 py-3 border-b border-white/5">
          <div>
            <div className="text-sm font-medium text-neutral-100">History</div>
            <div className="text-[10px] uppercase tracking-wider text-neutral-500 mt-0.5">
              {history.length} entr{history.length === 1 ? 'y' : 'ies'} this session
            </div>
          </div>
          <IconButton
            icon={<IconX size={16} />}
            onClick={() => setHistoryOpen(false)}
            variant="ghost"
            size="sm"
            aria-label="Close history"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-3 pb-safe-bottom">
          {history.length === 0 ? (
            <div className="flex items-center justify-center h-full text-xs text-neutral-600">
              No generations yet this session.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {history.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    restoreFromHistory(entry.id);
                    setHistoryOpen(false);
                  }}
                  className={classNames(
                    'flex gap-3 p-2 rounded-lg text-left',
                    'bg-white/5 hover:bg-white/10 ring-1 ring-white/5 hover:ring-white/20',
                    'transition-all',
                  )}
                >
                  <div className="flex-shrink-0 w-14 h-14 rounded-md overflow-hidden bg-neutral-900">
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
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[9px] uppercase tracking-wider text-neutral-500">
                        {entry.mode}
                      </span>
                      <span className="text-[9px] text-neutral-600">
                        · {entry.outputImageIds.length} image
                        {entry.outputImageIds.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="text-xs text-neutral-200 line-clamp-2 leading-snug">
                      {entry.prompt || '(no prompt)'}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
