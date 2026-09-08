'use client';

import {
  IconBrain,
  IconPlus,
  IconSearch,
  IconLogout,
  IconTrash,
  IconX,
  IconCheck,
  IconRobot,
  IconDownload,
  IconPencil,
  IconPlugConnected,
} from '@tabler/icons-react';
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';

import { apiDelete } from '@/utils/app/api';
import { saveConversation } from '@/utils/app/conversation';

import { Conversation } from '@/types/chat';

import { useAuth } from '@/components/auth';
import { AppearanceSettings } from '@/components/layout/AppearanceSettings';
import { Button, IconButton, Input } from '@/components/primitives';
import { GlassPanel } from '@/components/surfaces';

import { useConversationStore, useUISettingsStore } from '@/state';
import classNames from 'classnames';
import { v4 as uuidv4 } from 'uuid';

const rowActionClasses =
  'flex h-[44px] w-[44px] items-center justify-center rounded-md text-dark-text-muted transition-all md:h-7 md:w-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40';

export const Sidebar = memo(() => {
  const { logout } = useAuth();

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
  const clearConversationsFromStore = useConversationStore(
    (s) => s.clearConversations,
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
  const renameInputRef = useRef<HTMLInputElement>(null);

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
    const newConv: Conversation = {
      id: uuidv4(),
      name: 'New Conversation',
      messages: [],
      folderId: null,
      updatedAt: Date.now(),
    };
    addConversation(newConv);
    selectConversation(newConv.id);
    saveConversation(newConv);
    closeSidebarOnMobile();
  }, [addConversation, selectConversation, closeSidebarOnMobile]);

  const handleSelect = useCallback(
    (id: string) => {
      selectConversation(id);
      closeSidebarOnMobile();
    },
    [selectConversation, closeSidebarOnMobile],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const wasSelected =
        useConversationStore.getState().selectedConversationId === id;

      // Remove from store (also clears selectedConversationId if it matches)
      deleteConversationFromStore(id);
      setConfirmingDeleteId(null);

      // Persist deletion to Redis
      try {
        await apiDelete(`/api/conversations/${id}`);
      } catch (err) {
        console.error('Failed to delete conversation from server:', err);
      }

      // If we deleted the active conversation, select another or create new
      if (wasSelected) {
        const remaining = useConversationStore.getState().conversations;
        if (remaining.length > 0) {
          selectConversation(remaining[remaining.length - 1].id);
        } else {
          handleNewConversation();
        }
      }
    },
    [deleteConversationFromStore, selectConversation, handleNewConversation],
  );

  const startRename = useCallback((conv: Conversation) => {
    setConfirmingDeleteId(null);
    setRenamingId(conv.id);
    setRenameValue(conv.name);
  }, []);

  const commitRename = useCallback(() => {
    if (!renamingId) return;
    const name = renameValue.trim();
    const conv = useConversationStore
      .getState()
      .conversations.find((c) => c.id === renamingId);
    setRenamingId(null);
    if (!conv || !name || name === conv.name) return;
    const updated = { ...conv, name, updatedAt: Date.now() };
    updateConversation(renamingId, { name, updatedAt: updated.updatedAt });
    saveConversation(updated);
  }, [renamingId, renameValue, updateConversation]);

  const handleDownloadTraces = useCallback((id: string) => {
    const link = document.createElement('a');
    link.href = `/api/conversations/${encodeURIComponent(id)}/traces`;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, []);

  const handleClearAll = useCallback(async () => {
    // Grab IDs before clearing (exclude autonomous agent)
    const ids = useConversationStore
      .getState()
      .conversations.filter((c) => c.id !== 'autonomous-agent-thoughts')
      .map((c) => c.id);

    // Preserve autonomous agent conversation
    const autonomousConv = useConversationStore
      .getState()
      .conversations.find((c) => c.id === 'autonomous-agent-thoughts');

    // Clear store
    clearConversationsFromStore();

    // Re-add autonomous agent conversation if it existed
    if (autonomousConv) {
      useConversationStore.getState().addConversation(autonomousConv);
    }

    // Delete each from Redis (skips autonomous)
    for (const id of ids) {
      try {
        await apiDelete(`/api/conversations/${id}`);
      } catch {}
    }

    // Create a fresh conversation
    handleNewConversation();
    setIsConfirmingClear(false);
  }, [clearConversationsFromStore, handleNewConversation]);

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
      <div className="flex min-h-14 shrink-0 items-center justify-between px-5 pt-safe-top">
        <span className="min-w-0 truncate text-lg font-semibold tracking-tight text-primary">
          Daedalus
        </span>
        <IconButton
          icon={<IconX size={18} />}
          aria-label="Close sidebar"
          variant="ghost"
          className="shrink-0"
          onClick={() => setShowChatbar(false)}
        />
      </div>
      {/* Header */}
      <div className="flex-shrink-0 p-3 space-y-2">
        <Button
          variant="accent"
          fullWidth
          size="md"
          leftIcon={<IconPlus size={18} />}
          onClick={handleNewConversation}
          className="min-h-touch-min"
        >
          New Chat
        </Button>

        <Input
          type="search"
          placeholder="Search conversations..."
          aria-label="Search conversations"
          size="sm"
          leftIcon={<IconSearch size={16} />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {/* Conversation list */}
      <nav
        aria-label="Conversation history"
        className="min-h-[6rem] flex-1 overflow-y-auto overscroll-contain px-2 py-1"
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
                  <div className="flex items-center gap-1 rounded-lg border-l-2 border-nvidia-green bg-nvidia-green/10 px-2 py-1.5">
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      aria-label="Conversation name"
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          setRenamingId(null);
                          requestAnimationFrame(() =>
                            document
                              .getElementById(`rename-conversation-${conv.id}`)
                              ?.focus(),
                          );
                        }
                      }}
                      onBlur={commitRename}
                      className="min-w-0 flex-1 rounded-md border border-separator/70 bg-dark-bg-tertiary px-2 py-1.5 text-sm text-dark-text-primary focus:outline-none focus:ring-1 focus:ring-nvidia-green/40"
                    />
                    <button
                      type="button"
                      aria-label="Save name"
                      className={classNames(
                        rowActionClasses,
                        'hover:bg-nvidia-green/15 hover:text-nvidia-green',
                      )}
                      // onMouseDown so it wins over the input's onBlur commit
                      onMouseDown={(e) => {
                        e.preventDefault();
                        commitRename();
                      }}
                    >
                      <IconCheck size={16} />
                    </button>
                  </div>
                </li>
              );
            }

            if (isConfirmingDelete) {
              return (
                <li key={conv.id}>
                  <div className="flex min-h-touch-min items-center gap-1 rounded-lg bg-nvidia-red/10 px-3 py-1.5 text-sm text-nvidia-red">
                    <span className="min-w-0 flex-1 truncate">
                      Delete &ldquo;{conv.name}&rdquo;?
                    </span>
                    <button
                      type="button"
                      aria-label="Confirm delete"
                      className={classNames(
                        rowActionClasses,
                        'text-nvidia-red hover:bg-nvidia-red/15',
                      )}
                      onClick={() => handleDelete(conv.id)}
                    >
                      <IconCheck size={16} />
                    </button>
                    <button
                      type="button"
                      aria-label="Cancel delete"
                      className={classNames(
                        rowActionClasses,
                        'hover:bg-fill/[0.06] hover:text-dark-text-primary',
                      )}
                      onClick={() => setConfirmingDeleteId(null)}
                    >
                      <IconX size={16} />
                    </button>
                  </div>
                </li>
              );
            }

            return (
              <li key={conv.id}>
                <div
                  className={classNames(
                    'group w-full rounded-lg px-2 py-1 text-left transition-colors duration-150',
                    isActive
                      ? isAutonomous
                        ? 'bg-nvidia-purple/10 border-l-2 border-nvidia-purple text-dark-text-primary'
                        : 'bg-nvidia-green/10 border-l-2 border-nvidia-green text-dark-text-primary'
                      : 'text-dark-text-secondary hover:bg-fill/[0.04] border-l-2 border-transparent',
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <button
                      type="button"
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => handleSelect(conv.id)}
                      className="flex min-h-11 min-w-0 flex-[1_1_7rem] items-center gap-2 rounded-lg px-1 text-left"
                    >
                      {isAutonomous && (
                        <IconRobot
                          size={14}
                          className="text-nvidia-purple flex-shrink-0"
                        />
                      )}
                      <span className="truncate text-sm">{conv.name}</span>
                    </button>
                    {!isAutonomous && (
                      <div className="flex flex-shrink-0 items-center opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                        <button
                          type="button"
                          id={`rename-conversation-${conv.id}`}
                          aria-label="Rename conversation"
                          title="Rename"
                          className={classNames(
                            rowActionClasses,
                            'hover:bg-fill/[0.06] hover:text-dark-text-primary',
                          )}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            startRename(conv);
                          }}
                        >
                          <IconPencil size={16} />
                        </button>
                        <button
                          type="button"
                          aria-label="Download conversation traces"
                          title="Download traces"
                          className={classNames(
                            rowActionClasses,
                            'hover:bg-fill/[0.06] hover:text-dark-text-primary',
                          )}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleDownloadTraces(conv.id);
                          }}
                        >
                          <IconDownload size={16} />
                        </button>
                        <button
                          type="button"
                          aria-label="Delete conversation"
                          title="Delete conversation"
                          className={classNames(
                            rowActionClasses,
                            'hover:bg-nvidia-red/10 hover:text-nvidia-red',
                          )}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setConfirmingDeleteId(conv.id);
                          }}
                        >
                          <IconX size={16} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer */}
      <div className="app-sidebar-footer flex min-h-0 flex-shrink flex-col max-h-[45%] border-t border-separator">
        <div className="min-h-0 overflow-y-auto overscroll-contain px-3 pt-3 space-y-1">
          <AppearanceSettings />
          <button
            onClick={() => {
              setActiveView('memory');
              closeSidebarOnMobile();
            }}
            className="flex min-h-touch-min w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-dark-text-muted transition-colors hover:bg-fill/[0.04] hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40"
          >
            <IconBrain size={16} />
            <span>Memory Center</span>
          </button>
          <button
            onClick={() => {
              setActiveView('connections');
              closeSidebarOnMobile();
            }}
            className="flex min-h-touch-min w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-dark-text-muted transition-colors hover:bg-fill/[0.04] hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40"
          >
            <IconPlugConnected size={16} />
            <span>Connections</span>
          </button>

          {/* Clear all conversations */}
          {conversations.length > 0 && (
            <div>
              {isConfirmingClear ? (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-nvidia-red">
                  <span className="flex-1">Clear all conversations?</span>
                  <IconButton
                    icon={<IconCheck size={16} />}
                    aria-label="Confirm clear"
                    variant="danger"
                    size="sm"
                    onClick={handleClearAll}
                  />
                  <IconButton
                    icon={<IconX size={16} />}
                    aria-label="Cancel"
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsConfirmingClear(false)}
                  />
                </div>
              ) : (
                <button
                  onClick={() => setIsConfirmingClear(true)}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-dark-text-muted hover:text-nvidia-red rounded-lg hover:bg-nvidia-red/5 transition-colors min-h-touch-min focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-red/40"
                >
                  <IconTrash size={16} />
                  <span>Clear Conversations</span>
                </button>
              )}
            </div>
          )}

          <button
            onClick={() => logout()}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-dark-text-muted hover:text-dark-text-primary rounded-lg hover:bg-fill/[0.04] transition-colors min-h-touch-min focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-separator/70"
          >
            <IconLogout size={16} />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </GlassPanel>
  );
});

Sidebar.displayName = 'Sidebar';
