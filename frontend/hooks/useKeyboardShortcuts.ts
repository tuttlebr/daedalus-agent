'use client';

import { useCallback, useEffect } from 'react';

type ModifierKey = 'ctrl' | 'alt' | 'shift' | 'meta';

interface KeyboardShortcut {
  /** The key to listen for (e.g., 'Enter', 'Escape', 'k', etc.) */
  key: string;
  /** Modifier keys required (ctrl/cmd, alt, shift) */
  modifiers?: ModifierKey[];
  /** Callback when shortcut is triggered */
  handler: (event: KeyboardEvent) => void;
  /** Whether to prevent default browser behavior */
  preventDefault?: boolean;
  /** Whether to stop event propagation */
  stopPropagation?: boolean;
  /** Only trigger when target is a specific element */
  targetSelector?: string;
  /** Description for help/documentation */
  description?: string;
  /** Whether the shortcut is currently enabled */
  enabled?: boolean;
}

interface UseKeyboardShortcutsOptions {
  /** Array of keyboard shortcuts to register */
  shortcuts: KeyboardShortcut[];
  /** Whether all shortcuts are enabled */
  enabled?: boolean;
  /** Element to attach listeners to (default: document) */
  scope?: 'document' | 'window';
}

/**
 * Custom hook for managing keyboard shortcuts
 *
 * Features:
 * - Multiple shortcut registration
 * - Modifier key support (Ctrl/Cmd, Alt, Shift)
 * - Per-shortcut enable/disable
 * - Target element filtering
 * - Mac Cmd / Windows Ctrl normalization
 */
export function useKeyboardShortcuts({
  shortcuts,
  enabled = true,
  scope = 'document',
}: UseKeyboardShortcutsOptions): void {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled) return;

      // Check each shortcut
      for (const shortcut of shortcuts) {
        if (shortcut.enabled === false) continue;

        // Check if key matches (case-insensitive)
        const keyMatches =
          event.key.toLowerCase() === shortcut.key.toLowerCase() ||
          event.code.toLowerCase() === shortcut.key.toLowerCase();

        if (!keyMatches) continue;

        // Check modifiers
        const modifiers = shortcut.modifiers || [];
        const modifiersMatch =
          modifiers.every((mod) => {
            switch (mod) {
              case 'ctrl':
                // On Mac, treat Cmd as Ctrl
                return event.ctrlKey || event.metaKey;
              case 'alt':
                return event.altKey;
              case 'shift':
                return event.shiftKey;
              case 'meta':
                return event.metaKey;
              default:
                return false;
            }
          }) &&
          // Ensure no extra modifiers are pressed (except for specified ones)
          (modifiers.includes('ctrl') || (!event.ctrlKey && !event.metaKey)) &&
          (modifiers.includes('alt') || !event.altKey) &&
          (modifiers.includes('shift') || !event.shiftKey);

        if (!modifiersMatch) continue;

        // Check target selector if specified
        if (shortcut.targetSelector) {
          const target = event.target as Element;
          if (!target.matches(shortcut.targetSelector)) continue;
        }

        // Prevent triggering shortcuts when typing in inputs (unless explicitly targeting them)
        const target = event.target as HTMLElement;
        const isInputElement =
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable;

        if (isInputElement && !shortcut.targetSelector) {
          // Allow Escape and modifier-key shortcuts (Ctrl/Cmd+X) to work in inputs
          const hasModifier = modifiers.length > 0;
          if (shortcut.key.toLowerCase() !== 'escape' && !hasModifier) {
            continue;
          }
        }

        // Execute the handler
        if (shortcut.preventDefault !== false) {
          event.preventDefault();
        }
        if (shortcut.stopPropagation) {
          event.stopPropagation();
        }
        shortcut.handler(event);
        return;
      }
    },
    [enabled, shortcuts]
  );

  useEffect(() => {
    const target = scope === 'window' ? window : document;
    target.addEventListener('keydown', handleKeyDown as EventListener);

    return () => {
      target.removeEventListener('keydown', handleKeyDown as EventListener);
    };
  }, [handleKeyDown, scope]);
}

// =============================================================================
// COMMON SHORTCUTS
// =============================================================================

/**
 * Common keyboard shortcut patterns
 */
export const commonShortcuts = {
  /** Escape key (works in inputs) */
  escape: (handler: () => void): KeyboardShortcut => ({
    key: 'Escape',
    handler: () => handler(),
    description: 'Close or cancel',
  }),

  /** Ctrl/Cmd + Enter (submit) */
  submit: (handler: () => void): KeyboardShortcut => ({
    key: 'Enter',
    modifiers: ['ctrl'],
    handler: () => handler(),
    description: 'Submit',
  }),

  /** Ctrl/Cmd + K (command palette / search) */
  commandPalette: (handler: () => void): KeyboardShortcut => ({
    key: 'k',
    modifiers: ['ctrl'],
    handler: () => handler(),
    description: 'Open command palette',
  }),

  /** Ctrl/Cmd + N (new item) */
  newItem: (handler: () => void): KeyboardShortcut => ({
    key: 'n',
    modifiers: ['ctrl'],
    handler: () => handler(),
    description: 'Create new item',
  }),

  /** Ctrl/Cmd + S (save) */
  save: (handler: () => void): KeyboardShortcut => ({
    key: 's',
    modifiers: ['ctrl'],
    handler: () => handler(),
    description: 'Save',
  }),

  /** Arrow down */
  arrowDown: (handler: () => void): KeyboardShortcut => ({
    key: 'ArrowDown',
    handler: () => handler(),
    preventDefault: true,
    description: 'Move down',
  }),

  /** Arrow up */
  arrowUp: (handler: () => void): KeyboardShortcut => ({
    key: 'ArrowUp',
    handler: () => handler(),
    preventDefault: true,
    description: 'Move up',
  }),

  /** Ctrl/Cmd + B (toggle sidebar) */
  toggleSidebar: (handler: () => void): KeyboardShortcut => ({
    key: 'b',
    modifiers: ['ctrl'],
    handler: () => handler(),
    description: 'Toggle sidebar',
  }),
};

export default useKeyboardShortcuts;
