'use client';

import { useCallback, useState } from 'react';
import { Message } from '@/types/chat';

interface UseMessageActionsOptions {
  /** Callback when regenerate is requested */
  onRegenerate?: (message: Message) => void;
  /** Callback when message is edited */
  onEdit?: (message: Message, newContent: string, messageIndex: number) => void;
  /** Callback when message is deleted */
  onDelete?: (messageIndex: number) => void;
}

interface UseMessageActionsReturn {
  /** Copy message content to clipboard */
  copyToClipboard: (content: string) => Promise<boolean>;
  /** Whether a message was recently copied */
  messageCopied: boolean;
  /** Request message regeneration */
  requestRegenerate: (message: Message) => void;
  /** Edit a message */
  editMessage: (message: Message, newContent: string, messageIndex: number) => void;
  /** Delete a message */
  deleteMessage: (messageIndex: number) => void;
  /** Currently editing message index (-1 if not editing) */
  editingIndex: number;
  /** Start editing a message */
  startEditing: (index: number) => void;
  /** Cancel editing */
  cancelEditing: () => void;
}

/**
 * Custom hook for managing chat message actions
 */
export function useMessageActions({
  onRegenerate,
  onEdit,
  onDelete,
}: UseMessageActionsOptions = {}): UseMessageActionsReturn {
  const [messageCopied, setMessageCopied] = useState(false);
  const [editingIndex, setEditingIndex] = useState(-1);

  // Copy content to clipboard
  const copyToClipboard = useCallback(async (content: string): Promise<boolean> => {
    if (typeof navigator === 'undefined' || !navigator.clipboard || !content) {
      return false;
    }

    try {
      await navigator.clipboard.writeText(content);
      setMessageCopied(true);
      setTimeout(() => setMessageCopied(false), 2000);
      return true;
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      return false;
    }
  }, []);

  // Request regeneration of a message
  const requestRegenerate = useCallback((message: Message) => {
    if (onRegenerate) {
      onRegenerate(message);
    }
  }, [onRegenerate]);

  // Edit a message
  const editMessage = useCallback((message: Message, newContent: string, messageIndex: number) => {
    if (onEdit) {
      onEdit(message, newContent, messageIndex);
    }
    setEditingIndex(-1);
  }, [onEdit]);

  // Delete a message
  const deleteMessage = useCallback((messageIndex: number) => {
    if (onDelete) {
      onDelete(messageIndex);
    }
  }, [onDelete]);

  // Start editing a message
  const startEditing = useCallback((index: number) => {
    setEditingIndex(index);
  }, []);

  // Cancel editing
  const cancelEditing = useCallback(() => {
    setEditingIndex(-1);
  }, []);

  return {
    copyToClipboard,
    messageCopied,
    requestRegenerate,
    editMessage,
    deleteMessage,
    editingIndex,
    startEditing,
    cancelEditing,
  };
}

export default useMessageActions;
