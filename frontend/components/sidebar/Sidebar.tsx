'use client';

import {
  IconPlus,
  IconSearch,
  IconLogout,
  IconTrash,
  IconX,
  IconCheck,
  IconMessageCircle,
  IconRobot,
} from '@tabler/icons-react';
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';

import { useFileSave } from '@/hooks/useFileSave';

import { apiDelete } from '@/utils/app/api';
import {
  createConversation,
  persistSelectedConversation,
  saveConversation,
} from '@/utils/app/conversation';
import { downloadFilename } from '@/utils/app/sandboxArtifactDownload';

import { Conversation } from '@/types/chat';

import { useAuth } from '@/components/auth';
import { AppearanceSettings } from '@/components/layout/AppearanceSettings';
import { IconButton, Input } from '@/components/primitives';
import { GlassPanel } from '@/components/surfaces';

import { ConversationActions } from './ConversationActions';

import { branding } from '@/generated/branding';
import { useConversationStore, useUISettingsStore } from '@/state';
import classNames from 'classnames';

const rowActionClasses =
  'flex h-[44px] w-[44px] items-center justify-center rounded-full text-dark-text-muted transition-colors md:h-7 md:w-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
const confirmActionClasses =
  'min-h-touch-min rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:min-h-8';
// Footer commands and New Chat are rows: one height, one leading edge.
const sidebarRowButtonClasses =
  'flex min-h-8 w-full items-center gap-2.5 rounded-lg py-1.5 text-left text-sm text-primary transition-colors hover:bg-fill/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

/** Return focus to a conversation's More button after its menu action ends. */
function focusConversationActions(id: string) {
  requestAnimationFrame(() =>
    document.getElementById(`conversation-actions-${id}`)?.focus(),
  );
}

export const Sidebar = memo(() => {
  const { logout } = useAuth();
  const { saveFile, fileSaveDialog } = useFileSave();

  const conversations = useConversationStore((s) => s.conversations);
  const selectedConversationId = useConversationStore(
    (s) => s.selectedConversationId,
  );
  const selectConversation = useConversationStore((s) => s.selectConversation);
  const addConversation = useConversationStore((s) => s.addConversation);
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const deleteConversationFromStore = useConversationStore(
    (s) => s.deleteConversation,
  );

  const searchTerm = useUISettingsStore((s) => s.searchTerm);
  const setSearchTerm = useUISettingsStore((s) => s.setSearchTerm);
  const setShowChatbar = useUISettingsStore((s) => s.setShowChatbar);
  const setActiveView = useUISettingsStore((s) => s.setActiveView);

  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const confirmDeleteRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmingDeleteId) confirmDeleteRef.current?.focus();
  }, [confirmingDeleteId]);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  const closeSidebarOnMobile = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setShowChatbar(false);
    }
  }, [setShowChatbar]);

  const handleNewConversation = useCallback(() => {
    const newConv = createConversation();
    addConversation(newConv);
    selectConversation(newConv.id);
    void persistSelectedConversation(newConv.id);
    void saveConversation(newConv).catch(() =>
      setError(
        'Could not save the new chat. Your chat is still available here; try again when connected.',
      ),
    );
    setSearchTerm('');
    setActiveView('chat');
    closeSidebarOnMobile();
  }, [
    addConversation,
    selectConversation,
    closeSidebarOnMobile,
    setActiveView,
    setSearchTerm,
  ]);

  const handleSelect = useCallback(
    (id: string) => {
      selectConversation(id);
      // A reload, here or on another device, reopens the user's choice.
      void persistSelectedConversation(id);
      setActiveView('chat');
      closeSidebarOnMobile();
    },
    [selectConversation, closeSidebarOnMobile, setActiveView],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (pending) return;
      setPending(id);
      setError(null);
      try {
        await apiDelete(`/api/conversations/${encodeURIComponent(id)}`);
        const wasSelected =
          useConversationStore.getState().selectedConversationId === id;
        deleteConversationFromStore(id);
        setConfirmingDeleteId(null);
        if (wasSelected) {
          const remaining = useConversationStore.getState().conversations;
          if (remaining.length)
            selectConversation(remaining[remaining.length - 1].id);
          else handleNewConversation();
        }
      } catch {
        setError(
          'Could not delete this conversation. It is still in your history. Try again.',
        );
      } finally {
        setPending(null);
      }
    },
    [
      deleteConversationFromStore,
      selectConversation,
      handleNewConversation,
      pending,
    ],
  );

  const startRename = useCallback((conv: Conversation) => {
    setError(null);
    setConfirmingDeleteId(null);
    setRenamingId(conv.id);
    setRenameValue(conv.name);
  }, []);

  const cancelRename = useCallback((id: string) => {
    setRenamingId(null);
    setError(null);
    focusConversationActions(id);
  }, []);

  const commitRename = useCallback(async () => {
    if (!renamingId || pending) return;
    const name = renameValue.trim();
    const conv = useConversationStore
      .getState()
      .conversations.find((c) => c.id === renamingId);
    if (!conv || !name) return;
    if (name === conv.name) {
      cancelRename(renamingId);
      return;
    }
    setPending(renamingId);
    setError(null);
    try {
      // If another device saved this conversation meanwhile, the rename is
      // applied to its newer copy instead of reverting either change.
      await saveConversation({ ...conv, name }, { fields: ['name'] });
      updateConversation(renamingId, { name });
      cancelRename(renamingId);
    } catch {
      setError('Could not save the name. Your edit is still here. Try again.');
    } finally {
      setPending(null);
    }
  }, [renamingId, renameValue, updateConversation, pending, cancelRename]);

  const handleDownloadTraces = useCallback(
    async (id: string) => {
      if (pending) return;
      setPending(id);
      setError(null);
      try {
        const response = await fetch(
          `/api/conversations/${encodeURIComponent(id)}/traces`,
          { cache: 'no-store' },
        );
        if (!response.ok) throw new Error('Trace download failed');
        saveFile(
          await response.blob(),
          downloadFilename(response.headers.get('Content-Disposition')),
        );
      } catch {
        setError('Could not download activity. Try again.');
      } finally {
        setPending(null);
      }
    },
    [pending, saveFile],
  );

  const handleClearAll = useCallback(async () => {
    if (pending) return;
    setPending('clear-all');
    setError(null);
    const ids = useConversationStore
      .getState()
      .conversations.filter((c) => c.id !== 'autonomous-agent-thoughts')
      .map((c) => c.id);
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        await apiDelete(`/api/conversations/${encodeURIComponent(id)}`);
        deleteConversationFromStore(id);
      }),
    );
    const failed = results.filter(
      (result) => result.status === 'rejected',
    ).length;
    if (failed)
      setError(
        `Could not delete ${failed} conversation${
          failed === 1 ? '' : 's'
        }. They remain in your history. Try again.`,
      );
    else setIsConfirmingClear(false);
    if (!useConversationStore.getState().selectedConversationId) {
      const remaining = useConversationStore.getState().conversations;
      if (remaining.length) selectConversation(remaining[0].id);
      else handleNewConversation();
    }
    setPending(null);
  }, [
    pending,
    deleteConversationFromStore,
    selectConversation,
    handleNewConversation,
  ]);

  const filtered = searchTerm
    ? conversations.filter((c) =>
        c.name.toLowerCase().includes(searchTerm.toLowerCase()),
      )
    : conversations;

  const sorted = [...filtered].sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
  );

  return (
    <GlassPanel className="app-sidebar w-full h-full min-h-0 flex flex-col">
      <div className="app-sidebar-header flex shrink-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center">
          <img
            src={branding.assets['/favicon.png']}
            alt=""
            className="app-sidebar-brand shrink-0 object-contain"
          />
          <span className="min-w-0 truncate text-[0.9375rem] font-semibold tracking-tight text-primary">
            Daedalus
          </span>
        </div>
        {/* Wide windows close the sidebar from the toolbar; the drawer on
            phones keeps its own Close button. */}
        <IconButton
          icon={<IconX size={18} />}
          aria-label="Close sidebar"
          variant="ghost"
          className="shrink-0 md:hidden"
          onClick={() => setShowChatbar(false)}
        />
      </div>
      {/* Header */}
      <div className="app-sidebar-controls flex flex-shrink-0 flex-col gap-2 pb-2 pt-1">
        <button
          type="button"
          onClick={handleNewConversation}
          className={classNames(
            sidebarRowButtonClasses,
            'bg-fill/[0.07] font-medium hover:bg-fill/[0.12] dark:bg-control dark:hover:bg-control/80',
          )}
        >
          <IconPlus size={16} aria-hidden="true" className="flex-shrink-0" />
          New Chat
        </button>

        <Input
          type="search"
          placeholder="Search conversations"
          aria-label="Search conversations"
          size="sm"
          leftIcon={<IconSearch size={16} />}
          wrapperClassName="app-sidebar-search"
          className="!rounded-lg"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {error && (
        <p
          role="alert"
          className="mx-3 mb-2 rounded-lg bg-error/10 p-3 text-sm text-primary"
        >
          {error}
        </p>
      )}
      <h2 className="app-sidebar-section-label pb-1.5 pt-3 text-xs font-medium text-muted">
        Conversations
      </h2>
      {/* Conversation list */}
      <nav
        aria-label="Conversation history"
        className="app-sidebar-history flex-1 overflow-y-auto overscroll-contain py-1"
      >
        {sorted.length === 0 && (
          <p className="text-center text-xs text-dark-text-muted py-8">
            {searchTerm ? 'No conversations found' : 'No conversations yet'}
          </p>
        )}
        <ul className="space-y-0.5" role="list">
          {sorted.map((conv) => {
            const isActive = conv.id === selectedConversationId;
            const isAutonomous = conv.id === 'autonomous-agent-thoughts';
            const isConfirmingDelete = confirmingDeleteId === conv.id;
            const isRenaming = renamingId === conv.id;

            if (isRenaming) {
              return (
                <li key={conv.id}>
                  <div className="flex items-center gap-1 rounded-lg bg-fill/[0.08] px-1.5 py-1 ring-1 ring-inset ring-separator/50">
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      aria-label="Conversation name"
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing)
                          void commitRename();
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!pending) cancelRename(conv.id);
                        }
                      }}
                      disabled={pending !== null}
                      className="min-w-0 flex-1 rounded-md border border-separator/70 bg-dark-bg-tertiary px-2 py-1.5 text-sm text-dark-text-primary focus:outline-none focus:ring-1 focus:ring-focus"
                    />
                    <button
                      type="button"
                      aria-label="Save name"
                      className={classNames(
                        rowActionClasses,
                        'hover:bg-nvidia-green/15 hover:text-nvidia-green',
                      )}
                      disabled={pending !== null || !renameValue.trim()}
                      onClick={() => void commitRename()}
                    >
                      <IconCheck size={16} />
                    </button>
                    <button
                      type="button"
                      aria-label="Cancel rename"
                      disabled={pending !== null}
                      className={rowActionClasses}
                      onClick={() => cancelRename(conv.id)}
                    >
                      <IconX size={16} />
                    </button>
                  </div>
                </li>
              );
            }

            if (isConfirmingDelete) {
              return (
                <li key={conv.id}>
                  <div
                    role="group"
                    aria-label={`Delete ${conv.name}`}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-sm text-primary"
                  >
                    <span className="min-w-0 flex-[1_1_8rem] truncate">
                      Delete &ldquo;{conv.name}&rdquo;?
                    </span>
                    <div className="flex flex-shrink-0 items-center gap-1">
                      <button
                        type="button"
                        aria-label="Cancel delete"
                        disabled={pending !== null}
                        className={classNames(
                          confirmActionClasses,
                          'text-dark-text-primary hover:bg-fill/[0.06]',
                        )}
                        onClick={() => {
                          setConfirmingDeleteId(null);
                          focusConversationActions(conv.id);
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        ref={confirmDeleteRef}
                        aria-label="Confirm delete"
                        disabled={pending !== null}
                        className={classNames(
                          confirmActionClasses,
                          'bg-destructive text-on-destructive hover:bg-destructive/90',
                        )}
                        onClick={() => handleDelete(conv.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              );
            }

            return (
              <li key={conv.id}>
                <div
                  data-selected={isActive}
                  className={classNames(
                    'app-history-row group flex w-full items-center gap-1 pr-1 text-left text-primary transition-colors duration-150',
                    !isActive && 'hover:bg-fill/[0.05]',
                  )}
                >
                  <button
                    type="button"
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => handleSelect(conv.id)}
                    className={classNames(
                      'app-history-select flex min-h-8 min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1 text-left',
                      isActive && 'font-medium',
                    )}
                  >
                    {isAutonomous ? (
                      <IconRobot
                        size={16}
                        aria-hidden="true"
                        className="text-nvidia-purple flex-shrink-0"
                      />
                    ) : (
                      <IconMessageCircle
                        size={16}
                        aria-hidden="true"
                        className="flex-shrink-0 text-muted"
                      />
                    )}
                    <span className="truncate text-sm">{conv.name}</span>
                  </button>
                  {!isAutonomous && (
                    <ConversationActions
                      conversationId={conv.id}
                      conversationName={conv.name}
                      disabled={pending !== null}
                      onRename={() => startRename(conv)}
                      onDownload={() => void handleDownloadTraces(conv.id)}
                      onDelete={() => setConfirmingDeleteId(conv.id)}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer */}
      <div className="app-sidebar-footer flex max-h-[45%] min-h-0 flex-shrink flex-col">
        <div className="min-h-0 space-y-1 overflow-y-auto overscroll-contain pt-3">
          <AppearanceSettings />
          {/* Clear all conversations */}
          {conversations.length > 0 && (
            <div>
              {isConfirmingClear ? (
                <div
                  role="group"
                  aria-label="Clear all conversations"
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-sm text-primary"
                >
                  <span className="flex-[1_1_8rem]">
                    Clear all conversations?
                  </span>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label="Cancel"
                      disabled={pending !== null}
                      className={classNames(
                        confirmActionClasses,
                        'text-dark-text-primary hover:bg-fill/[0.06]',
                      )}
                      onClick={() => setIsConfirmingClear(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      aria-label="Confirm clear"
                      aria-busy={pending === 'clear-all'}
                      disabled={pending !== null}
                      className={classNames(
                        confirmActionClasses,
                        'bg-destructive text-on-destructive hover:bg-destructive/90',
                      )}
                      onClick={handleClearAll}
                    >
                      {pending === 'clear-all' ? 'Clearing…' : 'Clear'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsConfirmingClear(true)}
                  className={sidebarRowButtonClasses}
                >
                  <IconTrash
                    size={16}
                    aria-hidden="true"
                    className="flex-shrink-0 text-muted"
                  />
                  <span>Clear Conversations</span>
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => logout()}
            className={sidebarRowButtonClasses}
          >
            <IconLogout
              size={16}
              aria-hidden="true"
              className="flex-shrink-0 text-muted"
            />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
      {fileSaveDialog}
    </GlassPanel>
  );
});

Sidebar.displayName = 'Sidebar';
