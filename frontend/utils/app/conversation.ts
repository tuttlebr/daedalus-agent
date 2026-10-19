import { apiGet, apiPost, apiPut, ConflictError } from '@/utils/app/api';

import { Conversation, Message } from '@/types/chat';

import { cleanConversationHistory } from './clean';
import { conversationRevision } from './conversationRevision';
import { cleanMessagesForStorage, stripBase64Content } from './imageHandler';
import { getUserSessionItem, setUserSessionItem } from './storage';

import { useConversationStore } from '@/state/conversationStore';

/**
 * What a save changed in the browser's copy. The server accepts a save only
 * when its record is still the revision that copy was derived from. When
 * another device or the worker changed it first, these changes are re-applied
 * to the newer server copy instead of replacing it.
 */
export interface ConversationChange {
  /** Top-level fields set by this save, such as a rename. */
  fields?: Array<'name' | 'folderId'>;
  /**
   * Messages this save updated (an outcome the worker did not save, or Stop).
   * Their local copy updates the server's, except that a worker-finalized
   * answer keeps its saved content and only gains new metadata.
   */
  updatedMessageIds?: string[];
}

interface SaveResponse {
  revision?: unknown;
}

const MAX_SAVE_ATTEMPTS = 3;

// Saves of one conversation run in call order. A copy captured while an
// earlier save was queued already contains that save's changes, so it may use
// the revision that save committed as its base.
const saveQueues = new Map<string, Promise<unknown>>();
const lineages = new Map<
  string,
  { replaced: Set<string | null>; latest: string }
>();

function knownRevision(conversation: Conversation): string | null {
  return conversation.revision ?? null;
}

function baseRevisionFor(conversation: Conversation): string | null {
  const known = knownRevision(conversation);
  const lineage = lineages.get(conversation.id);
  return lineage?.replaced.has(known) ? lineage.latest : known;
}

function storageCopy(conversation: Conversation): Conversation {
  const { revision: _revision, ...fields } = conversation;
  // Persist complete history; attachment bytes are stored separately.
  return stripBase64Content({
    ...fields,
    messages: cleanMessagesForStorage(conversation.messages || []),
  });
}

function mergeUpdatedMessage(server: Message, local: Message): Message {
  if (server.metadata?.finalizationId && !local.metadata?.finalizationId) {
    // The worker's saved answer is authoritative. Keep it, adding only the
    // flags this browser set (for example that the user stopped it).
    return {
      ...server,
      metadata: { ...local.metadata, ...server.metadata },
    };
  }
  return {
    ...server,
    ...local,
    metadata: { ...server.metadata, ...local.metadata },
  };
}

/**
 * Re-apply a save's changes to a newer server copy. Server fields and messages
 * win except where this save changed them; messages the server does not have
 * yet (this browser's unsaved turn) are appended in their local order.
 */
export function rebaseConversation(
  server: Conversation,
  local: Conversation,
  change: ConversationChange = {},
): Conversation {
  const merged: Conversation = { ...server, id: local.id };
  for (const field of change.fields ?? []) {
    (merged as any)[field] = local[field];
  }
  const updated = new Set(change.updatedMessageIds ?? []);
  const localById = new Map(
    local.messages
      .filter((message) => typeof message.id === 'string' && message.id)
      .map((message) => [message.id as string, message]),
  );
  const serverMessages = Array.isArray(server.messages) ? server.messages : [];
  const serverIds = new Set<string>();
  const messages = serverMessages.map((message) => {
    if (!message?.id) return message;
    serverIds.add(message.id);
    const localMessage = localById.get(message.id);
    return localMessage && updated.has(message.id)
      ? mergeUpdatedMessage(message, localMessage)
      : message;
  });
  for (const [id, message] of Array.from(localById)) {
    if (!serverIds.has(id)) messages.push(message);
  }
  merged.messages = messages;
  return merged;
}

/**
 * Tell other sessions that a conversation changed. The event names the
 * conversation and its committed revision; receivers fetch the record.
 */
function notifySync(conversationId: string, revision?: string) {
  apiPost('/api/sync/notify', {
    type: 'conversation_updated',
    conversationId,
    ...(revision ? { revision } : {}),
  }).catch((err) => {
    console.warn('Sync notification failed (best-effort):', err);
  });
}

function recordCommit(
  id: string,
  replaced: Array<string | null>,
  revision: string,
  merged: Conversation | null,
) {
  const store = useConversationStore.getState();
  if (merged) {
    // Later queued copies lack the server changes merged here.
    lineages.set(id, { replaced: new Set(), latest: revision });
    if (!store.streamingConversationIds.has(id)) {
      const [adopted] = cleanConversationHistory([
        { ...merged, revision } as Conversation,
      ]);
      store.addConversation(adopted);
    }
    return;
  }
  const lineage = lineages.get(id);
  const chain: Set<string | null> =
    lineage && replaced.includes(lineage.latest)
      ? lineage.replaced
      : new Set<string | null>();
  for (const value of replaced) chain.add(value);
  if (lineage) chain.add(lineage.latest);
  lineages.set(id, { replaced: chain, latest: revision });
  store.applySavedRevision(id, Array.from(chain), revision);
}

async function persistConversation(
  conversation: Conversation,
  change: ConversationChange,
): Promise<Conversation> {
  const id = conversation.id;
  const known = knownRevision(conversation);
  let body = storageCopy(conversation);
  let base = baseRevisionFor(conversation);
  let merged = false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await apiPut<object, SaveResponse | undefined>(
        `/api/conversations/${encodeURIComponent(id)}`,
        { ...body, baseRevision: base },
      );
      const revision =
        typeof response?.revision === 'string' ? response.revision : undefined;
      if (revision) {
        recordCommit(id, [known, base], revision, merged ? body : null);
      }
      notifySync(id, revision);
      return revision ? { ...body, revision } : body;
    } catch (error) {
      if (
        !(error instanceof ConflictError) ||
        !error.serverState ||
        attempt >= MAX_SAVE_ATTEMPTS
      ) {
        throw error;
      }
      // Another device or the worker committed first. Keep its record and
      // re-apply only what this save changed.
      const server = error.serverState as Conversation;
      body = storageCopy(rebaseConversation(server, body, change));
      base = conversationRevision(server);
      merged = true;
    }
  }
}

/**
 * Save the browser's copy of a conversation. Selection is separate: saving a
 * background conversation never changes which conversation a reload opens.
 */
export function saveConversation(
  conversation: Conversation,
  change: ConversationChange = {},
): Promise<Conversation> {
  const id = conversation.id;
  const previous = saveQueues.get(id) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => persistConversation(conversation, change));
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  saveQueues.set(id, settled);
  void settled.then(() => {
    if (saveQueues.get(id) === settled) {
      saveQueues.delete(id);
      lineages.delete(id);
    }
  });
  return run.catch((error) => {
    console.error('Failed to persist conversation to server', error);
    throw error;
  });
}

// ---------------------------------------------------------------------------
// Selection: an id pointer, kept apart from conversation content.
// ---------------------------------------------------------------------------

const SELECTED_CONVERSATION_KEY = 'selectedConversation';
let serverSelectionId: string | null | undefined;
let selectionWrites: Promise<void> = Promise.resolve();
let pendingSelectionId: string | null = null;

function selectionIdOf(value: unknown): string | null {
  // Earlier versions stored a copy of the whole conversation; only its id is
  // used now.
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id ? id : null;
}

/** The selection this tab last made, from its session cache. */
export function cachedSelectedConversationId(): string | null {
  try {
    const cached = getUserSessionItem(SELECTED_CONVERSATION_KEY);
    return cached ? selectionIdOf(JSON.parse(cached)) : null;
  } catch {
    return null;
  }
}

/**
 * The id of the user's selected conversation: a string, null when none is
 * saved, or undefined when the server could not be read.
 */
export async function loadSelectedConversationId(): Promise<
  string | null | undefined
> {
  try {
    const selected = await apiGet<unknown>('/api/session/selectedConversation');
    serverSelectionId = selectionIdOf(selected);
    return serverSelectionId;
  } catch {
    return undefined;
  }
}

/** Remember this tab's selection (an id) for a reload of the same tab. */
export function rememberSelectedConversation(id: string): void {
  try {
    setUserSessionItem(SELECTED_CONVERSATION_KEY, JSON.stringify({ id }));
  } catch (error) {
    // Browser storage may be disabled; the server pointer still applies.
    console.warn('Failed to cache the selected conversation', error);
  }
}

/**
 * Save the conversation the user chose, in this tab and on the server (as an
 * id only), so a reload or another device reopens it. Automatic reselection,
 * for example after a deletion cleared the server pointer, stays local.
 */
export function persistSelectedConversation(id: string): Promise<void> {
  rememberSelectedConversation(id);
  pendingSelectionId = id;
  selectionWrites = selectionWrites.then(async () => {
    // Writes run in order and only the latest pending selection is sent.
    const next = pendingSelectionId;
    if (!next || next === serverSelectionId) return;
    try {
      await apiPut('/api/session/selectedConversation', { id: next });
      serverSelectionId = next;
    } catch (error) {
      console.warn('Failed to save the selected conversation', error);
    }
  });
  return selectionWrites;
}
