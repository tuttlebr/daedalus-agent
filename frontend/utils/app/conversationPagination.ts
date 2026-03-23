import { Conversation, Message } from '@/types/chat';

// Pagination configuration
const MESSAGES_IN_MEMORY = 50; // Keep last 50 messages in memory
const MESSAGES_PER_CHUNK = 100; // Store messages in chunks of 100
const MAX_CONVERSATION_MESSAGES = 500; // Maximum messages per conversation
const CONVERSATION_RETENTION_DAYS = 7; // Clean up conversations older than 7 days
const DB_NAME = 'DaedalusConversationsDB';
const DB_VERSION = 1;
const MESSAGES_STORE = 'messages';
const METADATA_STORE = 'metadata';

interface MessageChunk {
  id: string; // conversationId-chunkIndex
  conversationId: string;
  chunkIndex: number;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

interface ConversationMetadata {
  id: string;
  totalMessages: number;
  oldestMessageDate: number;
  newestMessageDate: number;
  lastAccessed: number;
}

class ConversationPaginationDB {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('Failed to open ConversationPaginationDB:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Messages store
        if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
          const messagesStore = db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
          messagesStore.createIndex('conversationId', 'conversationId', { unique: false });
          messagesStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        // Metadata store
        if (!db.objectStoreNames.contains(METADATA_STORE)) {
          const metadataStore = db.createObjectStore(METADATA_STORE, { keyPath: 'id' });
          metadataStore.createIndex('lastAccessed', 'lastAccessed', { unique: false });
        }
      };
    });

    return this.initPromise;
  }

  private async ensureDB(): Promise<IDBDatabase> {
    await this.initialize();
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }

  /**
   * Save older messages to IndexedDB and return only recent messages
   */
  async paginateConversation(conversation: Conversation): Promise<Conversation> {
    const messages = conversation.messages;

    if (messages.length <= MESSAGES_IN_MEMORY) {
      // No need to paginate
      return conversation;
    }

    // Separate messages into chunks
    const olderMessages = messages.slice(0, -MESSAGES_IN_MEMORY);
    const recentMessages = messages.slice(-MESSAGES_IN_MEMORY);

    // Store older messages in chunks
    await this.storeMessageChunks(conversation.id, olderMessages);

    // Update metadata
    await this.updateMetadata(conversation.id, messages);

    // Return conversation with only recent messages
    return {
      ...conversation,
      messages: recentMessages
    };
  }

  /**
   * Store messages in chunks
   */
  private async storeMessageChunks(conversationId: string, messages: Message[]): Promise<void> {
    const db = await this.ensureDB();
    const transaction = db.transaction([MESSAGES_STORE], 'readwrite');
    const store = transaction.objectStore(MESSAGES_STORE);

    const chunks = Math.ceil(messages.length / MESSAGES_PER_CHUNK);

    for (let i = 0; i < chunks; i++) {
      const startIdx = i * MESSAGES_PER_CHUNK;
      const endIdx = Math.min(startIdx + MESSAGES_PER_CHUNK, messages.length);
      const chunkMessages = messages.slice(startIdx, endIdx);

      const chunk: MessageChunk = {
        id: `${conversationId}-${i}`,
        conversationId,
        chunkIndex: i,
        messages: chunkMessages,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await new Promise((resolve, reject) => {
        const request = store.put(chunk);
        request.onsuccess = () => resolve(undefined);
        request.onerror = () => reject(request.error);
      });
    }
  }

  /**
   * Update conversation metadata
   */
  private async updateMetadata(conversationId: string, messages: Message[]): Promise<void> {
    const db = await this.ensureDB();
    const transaction = db.transaction([METADATA_STORE], 'readwrite');
    const store = transaction.objectStore(METADATA_STORE);

    const metadata: ConversationMetadata = {
      id: conversationId,
      totalMessages: messages.length,
      oldestMessageDate: Date.now(), // Should extract from first message if available
      newestMessageDate: Date.now(), // Should extract from last message if available
      lastAccessed: Date.now()
    };

    await new Promise((resolve, reject) => {
      const request = store.put(metadata);
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Load messages with pagination
   */
  async loadMessages(conversationId: string, offset: number = 0, limit: number = MESSAGES_IN_MEMORY): Promise<Message[]> {
    const db = await this.ensureDB();
    const transaction = db.transaction([MESSAGES_STORE], 'readonly');
    const store = transaction.objectStore(MESSAGES_STORE);
    const index = store.index('conversationId');

    const messages: Message[] = [];

    return new Promise((resolve, reject) => {
      const request = index.openCursor(IDBKeyRange.only(conversationId));

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          const chunk = cursor.value as MessageChunk;
          messages.push(...chunk.messages);
          cursor.continue();
        } else {
          // Return requested range
          resolve(messages.slice(offset, offset + limit));
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clean up old conversations
   */
  async cleanupOldConversations(): Promise<number> {
    const db = await this.ensureDB();
    const cutoffTime = Date.now() - (CONVERSATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let deletedCount = 0;

    // Clean up message chunks
    const messagesTransaction = db.transaction([MESSAGES_STORE], 'readwrite');
    const messagesStore = messagesTransaction.objectStore(MESSAGES_STORE);
    const updatedAtIndex = messagesStore.index('updatedAt');

    await new Promise((resolve, reject) => {
      const request = updatedAtIndex.openCursor(IDBKeyRange.upperBound(cutoffTime));

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          messagesStore.delete(cursor.primaryKey);
          deletedCount++;
          cursor.continue();
        } else {
          resolve(undefined);
        }
      };

      request.onerror = () => reject(request.error);
    });

    return deletedCount;
  }

  /**
   * Enforce conversation size limit
   */
  async enforceConversationLimit(conversationId: string): Promise<void> {
    const metadata = await this.getMetadata(conversationId);

    if (!metadata || metadata.totalMessages <= MAX_CONVERSATION_MESSAGES) {
      return;
    }

    // Load all messages
    const allMessages = await this.loadMessages(conversationId, 0, metadata.totalMessages);

    // Keep only the most recent messages
    const messagesToKeep = allMessages.slice(-MAX_CONVERSATION_MESSAGES);

    // Clear existing chunks
    await this.clearConversationMessages(conversationId);

    // Store the limited messages
    await this.storeMessageChunks(conversationId, messagesToKeep.slice(0, -MESSAGES_IN_MEMORY));
  }

  /**
   * Get conversation metadata
   */
  private async getMetadata(conversationId: string): Promise<ConversationMetadata | null> {
    const db = await this.ensureDB();
    const transaction = db.transaction([METADATA_STORE], 'readonly');
    const store = transaction.objectStore(METADATA_STORE);

    return new Promise((resolve, reject) => {
      const request = store.get(conversationId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all messages for a conversation (internal use)
   */
  private async clearConversationMessages(conversationId: string): Promise<void> {
    const db = await this.ensureDB();
    const transaction = db.transaction([MESSAGES_STORE], 'readwrite');
    const store = transaction.objectStore(MESSAGES_STORE);
    const index = store.index('conversationId');

    await new Promise((resolve, reject) => {
      const request = index.openCursor(IDBKeyRange.only(conversationId));

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve(undefined);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete a conversation completely from IndexedDB (messages and metadata)
   */
  async deleteConversation(conversationId: string): Promise<void> {
    const db = await this.ensureDB();

    // Clear messages
    await this.clearConversationMessages(conversationId);

    // Clear metadata
    const metaTransaction = db.transaction([METADATA_STORE], 'readwrite');
    const metaStore = metaTransaction.objectStore(METADATA_STORE);

    await new Promise((resolve, reject) => {
      const request = metaStore.delete(conversationId);
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all conversations from IndexedDB
   */
  async clearAllConversations(): Promise<void> {
    const db = await this.ensureDB();

    // Clear all messages
    const messagesTransaction = db.transaction([MESSAGES_STORE], 'readwrite');
    const messagesStore = messagesTransaction.objectStore(MESSAGES_STORE);
    await new Promise((resolve, reject) => {
      const request = messagesStore.clear();
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => reject(request.error);
    });

    // Clear all metadata
    const metaTransaction = db.transaction([METADATA_STORE], 'readwrite');
    const metaStore = metaTransaction.objectStore(METADATA_STORE);
    await new Promise((resolve, reject) => {
      const request = metaStore.clear();
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => reject(request.error);
    });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initPromise = null;
  }
}

// Create singleton instance
const paginationDB = new ConversationPaginationDB();

// Export functions
export async function paginateConversation(conversation: Conversation): Promise<Conversation> {
  return paginationDB.paginateConversation(conversation);
}

export async function loadConversationMessages(
  conversationId: string,
  offset: number = 0,
  limit: number = MESSAGES_IN_MEMORY
): Promise<Message[]> {
  return paginationDB.loadMessages(conversationId, offset, limit);
}

export async function cleanupOldConversations(): Promise<number> {
  return paginationDB.cleanupOldConversations();
}

export async function enforceConversationSizeLimit(conversationId: string): Promise<void> {
  return paginationDB.enforceConversationLimit(conversationId);
}

export async function deleteConversationFromDB(conversationId: string): Promise<void> {
  return paginationDB.deleteConversation(conversationId);
}

export async function clearAllConversationsFromDB(): Promise<void> {
  return paginationDB.clearAllConversations();
}

export { MESSAGES_IN_MEMORY, MAX_CONVERSATION_MESSAGES, CONVERSATION_RETENTION_DAYS };
