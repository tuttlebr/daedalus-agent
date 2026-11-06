import { isValidConversationId } from '@/server/chat/conversationId';
import type { AppView } from '@/state/uiSettingsStore';

const LINKABLE_VIEWS: ReadonlySet<AppView> = new Set([
  'chat',
  'create',
  'autonomy',
  'memory',
  'connections',
]);

export interface AppDeepLink {
  conversationId?: string;
  view?: AppView;
}

/**
 * Links Daedalus hands to API clients, such as an approval waiting in
 * `/?conversation=<id>` or `/?view=connections`. They only select what the
 * signed-in user can already open; an unknown or foreign conversation ID is
 * ignored by the caller's ownership-checked history.
 */
export function readAppDeepLink(search: string): AppDeepLink {
  const params = new URLSearchParams(search);
  const conversationId = params.get('conversation');
  const view = params.get('view');
  return {
    ...(isValidConversationId(conversationId) ? { conversationId } : {}),
    ...(view && LINKABLE_VIEWS.has(view as AppView)
      ? { view: view as AppView }
      : {}),
  };
}

/** Remove deep-link parameters so a reload does not repeat them. */
export function clearAppDeepLink(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('conversation') && !url.searchParams.has('view'))
    return;
  url.searchParams.delete('conversation');
  url.searchParams.delete('view');
  window.history.replaceState(
    window.history.state,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
}
