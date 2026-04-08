'use client';

import React, { memo, useCallback, useState } from 'react';
import { IconPlus, IconSearch, IconLogout, IconTrash, IconX, IconCheck, IconRobot } from '@tabler/icons-react';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from 'next-i18next';

import { useConversationStore, useUISettingsStore } from '@/state';
import { useAuth } from '@/components/auth';
import { GlassPanel } from '@/components/surfaces';
import { Button, IconButton, Input } from '@/components/primitives';
import { saveConversation, saveConversations } from '@/utils/app/conversation';
import { apiDelete } from '@/utils/app/api';
import { Conversation } from '@/types/chat';

export const Sidebar = memo(() => {
  const { t } = useTranslation('sidebar');
  const { logout } = useAuth();

  const conversations = useConversationStore((s) => s.conversations);
  const selectedConversationId = useConversationStore((s) => s.selectedConversationId);
  const selectConversation = useConversationStore((s) => s.selectConversation);
  const addConversation = useConversationStore((s) => s.addConversation);
  const deleteConversationFromStore = useConversationStore((s) => s.deleteConversation);
  const clearConversationsFromStore = useConversationStore((s) => s.clearConversations);

  const searchTerm = useUISettingsStore((s) => s.searchTerm);
  const setSearchTerm = useUISettingsStore((s) => s.setSearchTerm);
  const setShowChatbar = useUISettingsStore((s) => s.setShowChatbar);

  const [isConfirmingClear, setIsConfirmingClear] = useState(false);

  const closeSidebarOnMobile = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setShowChatbar(false);
    }
  }, [setShowChatbar]);

  const handleNewConversation = useCallback(() => {
    const newConv: Conversation = {
      id: uuidv4(),
      name: t('New Conversation'),
      messages: [],
      folderId: null,
      updatedAt: Date.now(),
    };
    addConversation(newConv);
    selectConversation(newConv.id);
    saveConversation(newConv);
    closeSidebarOnMobile();
  }, [addConversation, selectConversation, t, closeSidebarOnMobile]);

  const handleSelect = useCallback((id: string) => {
    selectConversation(id);
    closeSidebarOnMobile();
  }, [selectConversation, closeSidebarOnMobile]);

  const handleDelete = useCallback(async (id: string) => {
    const wasSelected = useConversationStore.getState().selectedConversationId === id;

    // Remove from store (also clears selectedConversationId if it matches)
    deleteConversationFromStore(id);

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
  }, [deleteConversationFromStore, selectConversation, handleNewConversation]);

  const handleClearAll = useCallback(async () => {
    // Grab IDs before clearing (exclude autonomous agent)
    const ids = useConversationStore.getState().conversations
      .filter((c) => c.id !== 'autonomous-agent-thoughts')
      .map((c) => c.id);

    // Preserve autonomous agent conversation
    const autonomousConv = useConversationStore.getState().conversations
      .find((c) => c.id === 'autonomous-agent-thoughts');

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
    ? conversations.filter((c) => c.name.toLowerCase().includes(searchTerm.toLowerCase()))
    : conversations;

  const sorted = [...filtered].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  return (
    <GlassPanel className="w-full h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 p-3 space-y-2">
        <Button
          variant="accent"
          fullWidth
          size="md"
          leftIcon={<IconPlus size={18} />}
          onClick={handleNewConversation}
        >
          New Chat
        </Button>

        <Input
          placeholder="Search conversations..."
          size="sm"
          leftIcon={<IconSearch size={16} />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5 scrollbar-hide">
        {sorted.length === 0 && (
          <p className="text-center text-xs text-dark-text-muted py-8">
            {searchTerm ? 'No conversations found' : 'No conversations yet'}
          </p>
        )}
        {sorted.map((conv) => {
          const isActive = conv.id === selectedConversationId;
          const isAutonomous = conv.id === 'autonomous-agent-thoughts';
          return (
            <button
              key={conv.id}
              onClick={() => handleSelect(conv.id)}
              className={`
                group w-full text-left px-3 py-2.5 rounded-lg
                transition-all duration-150 min-h-touch-min
                ${isActive
                  ? isAutonomous
                    ? 'bg-nvidia-purple/10 border-l-2 border-nvidia-purple text-dark-text-primary'
                    : 'bg-nvidia-green/10 border-l-2 border-nvidia-green text-dark-text-primary'
                  : 'text-dark-text-secondary hover:bg-white/[0.04] border-l-2 border-transparent'
                }
              `}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {isAutonomous && (
                    <IconRobot size={14} className="text-nvidia-purple flex-shrink-0" />
                  )}
                  <span className="truncate text-sm">{conv.name}</span>
                </div>
                {!isAutonomous && (
                  <button
                    type="button"
                    aria-label="Delete conversation"
                    className="flex-shrink-0 p-1.5 rounded-md opacity-0 group-hover:opacity-100 text-dark-text-muted hover:text-nvidia-red hover:bg-nvidia-red/10 transition-all"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleDelete(conv.id);
                    }}
                  >
                    <IconX size={14} />
                  </button>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 p-3 border-t border-white/[0.06] space-y-1">
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
                  size="xs"
                  onClick={handleClearAll}
                />
                <IconButton
                  icon={<IconX size={16} />}
                  aria-label="Cancel"
                  variant="ghost"
                  size="xs"
                  onClick={() => setIsConfirmingClear(false)}
                />
              </div>
            ) : (
              <button
                onClick={() => setIsConfirmingClear(true)}
                className="flex items-center gap-2 w-full px-3 py-2 text-sm text-dark-text-muted hover:text-nvidia-red rounded-lg hover:bg-nvidia-red/5 transition-colors min-h-touch-min"
              >
                <IconTrash size={16} />
                <span>Clear Conversations</span>
              </button>
            )}
          </div>
        )}

        <button
          onClick={() => logout()}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-dark-text-muted hover:text-dark-text-primary rounded-lg hover:bg-white/[0.04] transition-colors min-h-touch-min"
        >
          <IconLogout size={16} />
          <span>Sign Out</span>
        </button>
      </div>
    </GlassPanel>
  );
});

Sidebar.displayName = 'Sidebar';
