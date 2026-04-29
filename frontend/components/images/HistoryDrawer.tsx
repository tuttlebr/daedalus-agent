'use client';

import React, { useCallback, useEffect, useState } from 'react';
import classNames from 'classnames';
import {
  IconCheck,
  IconHistory,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { IconButton } from '@/components/primitives';
import { OptimizedImage } from '@/components/chat/OptimizedImage';
import { useImagePanelStore } from '@/state/imagePanelStore';
import { loadImageHistory } from './ImagePanel';

async function deleteImageHistoryEntry(id: string): Promise<void> {
  const res = await fetch(
    `/api/images/history?id=${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function clearImageHistoryRequest(): Promise<void> {
  const res = await fetch('/api/images/history?all=1', { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

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
  const removeFromHistory = useImagePanelStore((s) => s.removeFromHistory);
  const clearHistory = useImagePanelStore((s) => s.clearHistory);
  const setHistoryAction = useImagePanelStore((s) => s.setHistory);

  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHistoryOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, setHistoryOpen]);

  // Reset confirm state when the drawer closes so it doesn't reopen "armed".
  useEffect(() => {
    if (!open) setIsConfirmingClear(false);
  }, [open]);

  const reconcileFromServer = useCallback(async () => {
    try {
      const fresh = await loadImageHistory();
      setHistoryAction(fresh);
    } catch {
      // best-effort
    }
  }, [setHistoryAction]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (pendingDeleteIds.has(id)) return;
      setPendingDeleteIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      removeFromHistory(id);
      try {
        await deleteImageHistoryEntry(id);
      } catch (err) {
        console.error('Failed to delete history entry:', err);
        await reconcileFromServer();
      } finally {
        setPendingDeleteIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [removeFromHistory, pendingDeleteIds, reconcileFromServer],
  );

  const handleClearAll = useCallback(async () => {
    if (isClearing) return;
    setIsClearing(true);
    clearHistory();
    try {
      await clearImageHistoryRequest();
    } catch (err) {
      console.error('Failed to clear history:', err);
      await reconcileFromServer();
    } finally {
      setIsClearing(false);
      setIsConfirmingClear(false);
    }
  }, [clearHistory, isClearing, reconcileFromServer]);

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

        <div className="flex-1 overflow-y-auto p-3">
          {history.length === 0 ? (
            <div className="flex items-center justify-center h-full text-xs text-neutral-600">
              No generations yet this session.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {history.map((entry) => {
                const restore = () => {
                  restoreFromHistory(entry.id);
                  setHistoryOpen(false);
                };
                const isDeletingThis = pendingDeleteIds.has(entry.id);
                return (
                  <div
                    key={entry.id}
                    role="button"
                    tabIndex={0}
                    onClick={restore}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        restore();
                      }
                    }}
                    className={classNames(
                      'group relative flex gap-3 p-2 rounded-lg cursor-pointer',
                      'bg-white/5 hover:bg-white/10 ring-1 ring-white/5 hover:ring-white/20',
                      'transition-all',
                      'focus-visible:outline-none focus-visible:ring-nvidia-green/40',
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
                    <div className="flex-1 min-w-0 pr-5">
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
                    <button
                      type="button"
                      aria-label="Delete entry"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleDelete(entry.id);
                      }}
                      disabled={isDeletingThis}
                      className={classNames(
                        'absolute top-1.5 right-1.5 p-1 rounded-md',
                        'text-neutral-500 hover:text-nvidia-red hover:bg-nvidia-red/10',
                        'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                        'transition-all disabled:opacity-50',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-red/40',
                      )}
                    >
                      <IconX size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {history.length > 0 && (
          <div className="flex-shrink-0 border-t border-white/5 px-3 py-2 pb-safe-bottom">
            {isConfirmingClear ? (
              <div className="flex items-center gap-2 px-2 py-1 text-xs text-nvidia-red">
                <span className="flex-1">Clear all history?</span>
                <IconButton
                  icon={<IconCheck size={14} />}
                  aria-label="Confirm clear all"
                  variant="danger"
                  size="xs"
                  onClick={handleClearAll}
                  isLoading={isClearing}
                  disabled={isClearing}
                />
                <IconButton
                  icon={<IconX size={14} />}
                  aria-label="Cancel"
                  variant="ghost"
                  size="xs"
                  onClick={() => setIsConfirmingClear(false)}
                  disabled={isClearing}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsConfirmingClear(true)}
                className={classNames(
                  'flex items-center gap-2 w-full px-2 py-2 text-xs',
                  'text-neutral-500 hover:text-nvidia-red rounded-md',
                  'hover:bg-nvidia-red/5 transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-red/40',
                )}
              >
                <IconTrash size={14} />
                <span>Clear all history</span>
              </button>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
