'use client';

import {
  IconDots,
  IconDownload,
  IconPencil,
  IconTrash,
} from '@tabler/icons-react';
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';

import classNames from 'classnames';

interface ConversationActionsProps {
  conversationId: string;
  conversationName: string;
  disabled: boolean;
  /** Keeps the More button visible on wide screens, as for the open row. */
  emphasized: boolean;
  onRename: () => void;
  onDownload: () => void;
  onDelete: () => void;
}

// React 18 types predate the Popover API; the DOM passes these through.
const popover = { popover: 'auto' } as React.HTMLAttributes<HTMLDivElement>;
const invokes = (id: string) =>
  ({ popovertarget: id } as React.ButtonHTMLAttributes<HTMLButtonElement>);

/**
 * One More button per conversation opens a menu of its actions. The menu is a
 * top-layer popover, so the scrolling history list cannot clip it, and the
 * platform provides light dismissal and Escape.
 */
export const ConversationActions = memo(
  ({
    conversationId,
    conversationName,
    disabled,
    emphasized,
    onRename,
    onDownload,
    onDelete,
  }: ConversationActionsProps) => {
    const menuId = `conversation-menu-${conversationId}`;
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
      const menu = menuRef.current;
      const trigger = triggerRef.current;
      if (!menu || !trigger) return;
      type PopoverToggle = Event & { newState: 'open' | 'closed' };
      // The toggle event follows the opening paint; stay invisible until the
      // menu has been placed beside its button.
      const handleBeforeToggle = (event: Event) => {
        if ((event as PopoverToggle).newState === 'open')
          menu.style.visibility = 'hidden';
      };
      const handleToggle = (event: Event) => {
        const isOpen = (event as PopoverToggle).newState === 'open';
        setOpen(isOpen);
        if (!isOpen) {
          // Escape and light dismissal return focus to the More button
          // unless the chosen action has moved focus elsewhere.
          if (document.activeElement === document.body)
            trigger.focus({ preventScroll: true });
          return;
        }
        const anchor = trigger.getBoundingClientRect();
        const { width, height } = menu.getBoundingClientRect();
        const edge = 8;
        const below = anchor.bottom + 4;
        const top =
          below + height <= window.innerHeight - edge
            ? below
            : Math.max(edge, anchor.top - height - 4);
        const left = Math.min(
          Math.max(edge, anchor.right - width),
          window.innerWidth - width - edge,
        );
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
        menu.style.visibility = '';
        menu
          .querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
          ?.focus({ preventScroll: true });
      };
      menu.addEventListener('beforetoggle', handleBeforeToggle);
      menu.addEventListener('toggle', handleToggle);
      return () => {
        menu.removeEventListener('beforetoggle', handleBeforeToggle);
        menu.removeEventListener('toggle', handleToggle);
      };
    }, []);

    const choose = useCallback((action: () => void) => {
      menuRef.current?.hidePopover?.();
      action();
    }, []);

    const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      const items = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not(:disabled)',
        ),
      );
      const index = items.indexOf(document.activeElement as HTMLElement);
      let next: number | null = null;
      if (event.key === 'ArrowDown') next = (index + 1) % items.length;
      else if (event.key === 'ArrowUp')
        next = (index - 1 + items.length) % items.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = items.length - 1;
      else if (event.key === 'Tab') menuRef.current?.hidePopover?.();
      else if (event.key === 'Escape') {
        // WebKit would also send this Escape to an enclosing modal dialog,
        // closing the history drawer with the menu. Only the menu closes.
        event.preventDefault();
        event.stopPropagation();
        menuRef.current?.hidePopover?.();
        triggerRef.current?.focus({ preventScroll: true });
      }
      if (next !== null) {
        event.preventDefault();
        items[next]?.focus();
      }
    };

    const itemClasses =
      'flex min-h-touch-min w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-dark-text-primary transition-colors hover:bg-fill/[0.06] focus-visible:bg-fill/[0.06] focus-visible:outline-none disabled:opacity-50 md:min-h-8';

    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          id={`conversation-actions-${conversationId}`}
          aria-label={`Actions for ${conversationName}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          title="More"
          {...invokes(menuId)}
          className={classNames(
            'flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-dark-text-muted transition-opacity hover:bg-fill/[0.06] hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:h-7 md:w-7',
            'touch-action-controls',
            !emphasized && !open && 'md:opacity-0 md:group-hover:opacity-100',
            'md:focus-visible:opacity-100',
          )}
        >
          <IconDots size={16} aria-hidden="true" />
        </button>
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={`Actions for ${conversationName}`}
          {...popover}
          onKeyDown={handleMenuKeyDown}
          className="app-menu m-0 w-56 rounded-xl border border-separator/70 bg-elevated p-1 text-dark-text-primary shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            id={`rename-conversation-${conversationId}`}
            disabled={disabled}
            className={itemClasses}
            onClick={() => choose(onRename)}
          >
            <IconPencil size={16} aria-hidden="true" />
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            id={`download-conversation-${conversationId}`}
            disabled={disabled}
            className={itemClasses}
            onClick={() => choose(onDownload)}
          >
            <IconDownload size={16} aria-hidden="true" />
            Download Activity
          </button>
          <div role="separator" className="my-1 border-t border-separator/70" />
          <button
            type="button"
            role="menuitem"
            id={`delete-conversation-${conversationId}`}
            disabled={disabled}
            className={itemClasses}
            onClick={() => choose(onDelete)}
          >
            <IconTrash size={16} aria-hidden="true" />
            Delete…
          </button>
        </div>
      </>
    );
  },
);

ConversationActions.displayName = 'ConversationActions';
