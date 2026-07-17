'use client';

import { IconCheck, IconHistory, IconTrash, IconX } from '@tabler/icons-react';
import React, { useCallback, useEffect, useState } from 'react';

import { getImageOutputMimeType } from '@/utils/app/imageModelCapabilities';
import { useInvalidateImageHistory } from '@/utils/app/queries';

import { OptimizedImage } from '@/components/chat/OptimizedImage';
import { IconButton } from '@/components/primitives';

import { loadImageHistory } from './ImagePanel';

import { useImagePanelStore } from '@/state/imagePanelStore';
import classNames from 'classnames';

async function deleteImageHistoryEntry(id: string): Promise<void> {
  const res = await fetch(`/api/images/history?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function clearImageHistoryRequest(deleteAssets: boolean): Promise<void> {
  const params = new URLSearchParams({ all: '1' });
  if (deleteAssets) params.set('deleteAssets', '1');
  const res = await fetch(`/api/images/history?${params.toString()}`, {
    method: 'DELETE',
    credentials: 'include',
  });
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
  const setGallery = useImagePanelStore((s) => s.setGallery);

  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [deleteAssetsWithHistory, setDeleteAssetsWithHistory] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Auto-disarm the per-entry delete confirmation after a few seconds
  useEffect(() => {
    if (!confirmDeleteId) return;
    const timer = window.setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmDeleteId]);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(
    () => new Set(),
  );
  const invalidateImageHistory = useInvalidateImageHistory();

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
    if (!open) {
      setIsConfirmingClear(false);
      setDeleteAssetsWithHistory(false);
      setActionError(null);
    }
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
      setActionError(null);
      setPendingDeleteIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      removeFromHistory(id);
      try {
        await deleteImageHistoryEntry(id);
        invalidateImageHistory();
      } catch (err) {
        console.error('Failed to delete history entry:', err);
        setActionError(
          'Could not remove that saved run. Your history was restored.',
        );
        await reconcileFromServer();
      } finally {
        setPendingDeleteIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [
      invalidateImageHistory,
      removeFromHistory,
      pendingDeleteIds,
      reconcileFromServer,
    ],
  );

  const handleClearAll = useCallback(async () => {
    if (isClearing) return;
    const deleteAssets = deleteAssetsWithHistory;
    const galleryBeforeClear = useImagePanelStore.getState().gallery;
    setActionError(null);
    setIsClearing(true);
    clearHistory();
    if (deleteAssets) setGallery([]);
    try {
      await clearImageHistoryRequest(deleteAssets);
      invalidateImageHistory();
    } catch (err) {
      console.error('Failed to clear history:', err);
      if (deleteAssets) setGallery(galleryBeforeClear);
      setActionError(
        deleteAssets
          ? 'Could not clear the saved runs and generated images. Your history was restored.'
          : 'Could not clear saved history. Your history was restored.',
      );
      await reconcileFromServer();
    } finally {
      setIsClearing(false);
      setIsConfirmingClear(false);
      setDeleteAssetsWithHistory(false);
    }
  }, [
    clearHistory,
    deleteAssetsWithHistory,
    invalidateImageHistory,
    isClearing,
    reconcileFromServer,
    setGallery,
  ]);

  return (
    <>
      {/* backdrop */}
      <div
        className={classNames(
          'absolute inset-0 bg-black/50 transition-opacity duration-200',
          'z-40',
          open
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none',
        )}
        onClick={() => setHistoryOpen(false)}
        aria-hidden
      />

      {/* drawer */}
      <aside
        className={classNames(
          'absolute top-0 right-0 bottom-0 w-full md:w-[360px]',
          'bg-neutral-950/95 backdrop-blur-xl border-l border-white/10',
          'z-50',
          // visibility rides the same transition so the closed drawer is
          // removed from the tab order and accessibility tree only after
          // the slide-out finishes.
          'transition-[transform,visibility] duration-200 ease-out',
          open ? 'visible translate-x-0' : 'invisible translate-x-full',
          'flex flex-col',
        )}
        role="dialog"
        aria-modal="true"
        aria-label="Session history"
        aria-hidden={!open}
      >
        <div className="safe-top flex items-center justify-between px-4 py-3 border-b border-white/5">
          <div>
            <div className="text-sm font-medium text-neutral-100">History</div>
            <div className="text-[10px] uppercase tracking-wider text-neutral-500 mt-0.5">
              {history.length} saved creation{history.length === 1 ? '' : 's'}
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
              No saved creations yet.
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
                    className={classNames(
                      'group relative flex gap-3 p-2 rounded-lg cursor-pointer',
                      'bg-white/5 hover:bg-white/10 ring-1 ring-white/5 hover:ring-white/20',
                      'transition-all',
                      'focus-visible:outline-none focus-visible:ring-nvidia-green/40',
                    )}
                  >
                    <button
                      type="button"
                      onClick={restore}
                      className="flex min-w-0 flex-1 items-start gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40"
                      aria-label={`Restore saved ${entry.mode} creation`}
                    >
                      <div className="flex-shrink-0 w-14 h-14 rounded-md overflow-hidden bg-neutral-900">
                        {entry.outputImageIds[0] && (
                          <OptimizedImage
                            imageRef={{
                              imageId: entry.outputImageIds[0],
                              sessionId: 'generated',
                              mimeType: getImageOutputMimeType(entry.params),
                            }}
                            alt=""
                            useThumbnail
                            showControls={false}
                            enableFullscreen={false}
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
                    </button>
                    <button
                      type="button"
                      aria-label={
                        confirmDeleteId === entry.id
                          ? 'Tap again to confirm delete'
                          : 'Delete entry'
                      }
                      title={
                        confirmDeleteId === entry.id
                          ? 'Tap again to confirm delete'
                          : 'Delete entry'
                      }
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        // Two-tap confirm: the button sits over the restore
                        // target, so a stray tap must not destroy a creation.
                        if (confirmDeleteId === entry.id) {
                          setConfirmDeleteId(null);
                          handleDelete(entry.id);
                        } else {
                          setConfirmDeleteId(entry.id);
                        }
                      }}
                      disabled={isDeletingThis}
                      className={classNames(
                        'absolute top-1 right-1 grid h-11 w-11 place-items-center rounded-md touch-manipulation',
                        confirmDeleteId === entry.id
                          ? 'bg-nvidia-red/20 text-nvidia-red opacity-100'
                          : 'text-neutral-500 hover:text-nvidia-red hover:bg-nvidia-red/10 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100',
                        'transition-all disabled:opacity-50',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-red/40',
                      )}
                    >
                      {confirmDeleteId === entry.id ? (
                        <IconTrash size={14} />
                      ) : (
                        <IconX size={14} />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {history.length > 0 && (
          <div className="flex-shrink-0 border-t border-white/5 px-3 py-2 pb-safe-bottom">
            {actionError && (
              <p
                role="alert"
                className="mb-2 rounded-md bg-red-500/10 px-2 py-2 text-xs text-red-300"
              >
                {actionError}
              </p>
            )}
            {isConfirmingClear ? (
              <div className="rounded-lg bg-red-500/5 px-2 py-2 text-xs">
                <div className="font-medium text-neutral-100">
                  Clear saved history?
                </div>
                <p className="mt-1 leading-relaxed text-neutral-400">
                  Your current canvas stays unless you also choose to delete
                  generated images.
                </p>
                <label className="mt-2 flex min-h-11 cursor-pointer items-start gap-2 rounded-md px-1 py-1 text-neutral-300 hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={deleteAssetsWithHistory}
                    onChange={(event) =>
                      setDeleteAssetsWithHistory(event.target.checked)
                    }
                    className="mt-0.5 h-4 w-4 rounded border-white/20 bg-black/30 text-nvidia-green focus:ring-nvidia-green/50"
                  />
                  <span>
                    <span className="block font-medium">
                      Also delete generated images
                    </span>
                    <span className="block text-[11px] text-neutral-500">
                      This removes saved output assets, not downloaded copies.
                    </span>
                  </span>
                </label>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsConfirmingClear(false)}
                    disabled={isClearing}
                    className="min-h-11 rounded-lg px-3 text-xs font-medium text-neutral-300 hover:bg-white/5 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleClearAll}
                    disabled={isClearing}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-red-500/15 px-3 text-xs font-medium text-red-200 hover:bg-red-500/25 disabled:opacity-50"
                  >
                    <IconCheck size={15} />
                    {isClearing
                      ? 'Clearing…'
                      : deleteAssetsWithHistory
                      ? 'Clear and delete assets'
                      : 'Clear history'}
                  </button>
                </div>
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
