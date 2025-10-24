import { IntermediateStep } from '@/types/intermediateSteps';

// IndexedDB configuration
const DB_NAME = 'DaedalusIntermediateStepsDB';
const DB_VERSION = 1;
const STORE_NAME = 'intermediateSteps';
const CHUNK_SIZE = 100; // Store steps in chunks of 100
const MAX_AGE_HOURS = 24; // Clean up steps older than 24 hours

interface StepChunk {
  id: string;
  conversationId: string;
  chunkIndex: number;
  steps: IntermediateStep[];
  createdAt: number;
  updatedAt: number;
}

class IntermediateStepsDB {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('Failed to open IndexedDB:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('conversationId', 'conversationId', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
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

  async saveSteps(
    conversationId: string,
    steps: IntermediateStep[]
  ): Promise<void> {
    const db = await this.ensureDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    // Split steps into chunks
    const chunks: StepChunk[] = [];
    for (let i = 0; i < steps.length; i += CHUNK_SIZE) {
      const chunk: StepChunk = {
        id: `${conversationId}_chunk_${Math.floor(i / CHUNK_SIZE)}`,
        conversationId,
        chunkIndex: Math.floor(i / CHUNK_SIZE),
        steps: steps.slice(i, i + CHUNK_SIZE),
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      chunks.push(chunk);
    }

    // Save all chunks
    const promises = chunks.map(chunk =>
      new Promise<void>((resolve, reject) => {
        const request = store.put(chunk);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      })
    );

    await Promise.all(promises);
  }

  async loadSteps(
    conversationId: string,
    startIndex: number = 0,
    count: number = CHUNK_SIZE
  ): Promise<IntermediateStep[]> {
    const db = await this.ensureDB();
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('conversationId');

    return new Promise((resolve, reject) => {
      const steps: IntermediateStep[] = [];
      const request = index.openCursor(IDBKeyRange.only(conversationId));

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          const chunk = cursor.value as StepChunk;
          steps.push(...chunk.steps);
          cursor.continue();
        } else {
          // Return requested slice
          resolve(steps.slice(startIndex, startIndex + count));
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  async getStepCount(conversationId: string): Promise<number> {
    const db = await this.ensureDB();
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('conversationId');

    return new Promise((resolve, reject) => {
      let totalSteps = 0;
      const request = index.openCursor(IDBKeyRange.only(conversationId));

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          const chunk = cursor.value as StepChunk;
          totalSteps += chunk.steps.length;
          cursor.continue();
        } else {
          resolve(totalSteps);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  async cleanupOldSteps(): Promise<number> {
    const db = await this.ensureDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('createdAt');

    const cutoffTime = Date.now() - (MAX_AGE_HOURS * 60 * 60 * 1000);
    let deletedCount = 0;

    return new Promise((resolve, reject) => {
      const request = index.openCursor(IDBKeyRange.upperBound(cutoffTime));

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          deletedCount++;
          cursor.continue();
        } else {
          resolve(deletedCount);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  async clearConversationSteps(conversationId: string): Promise<void> {
    const db = await this.ensureDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('conversationId');

    return new Promise((resolve, reject) => {
      const request = index.openCursor(IDBKeyRange.only(conversationId));

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve();
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initPromise = null;
    }
  }
}

// Export singleton instance
export const intermediateStepsDB = new IntermediateStepsDB();

// Helper functions for easy usage
export async function saveIntermediateSteps(
  conversationId: string,
  steps: IntermediateStep[]
): Promise<void> {
  return intermediateStepsDB.saveSteps(conversationId, steps);
}

export async function loadIntermediateSteps(
  conversationId: string,
  startIndex: number = 0,
  count: number = CHUNK_SIZE
): Promise<IntermediateStep[]> {
  return intermediateStepsDB.loadSteps(conversationId, startIndex, count);
}

export async function getIntermediateStepCount(
  conversationId: string
): Promise<number> {
  return intermediateStepsDB.getStepCount(conversationId);
}

export async function cleanupOldIntermediateSteps(): Promise<number> {
  return intermediateStepsDB.cleanupOldSteps();
}

export async function clearConversationIntermediateSteps(
  conversationId: string
): Promise<void> {
  return intermediateStepsDB.clearConversationSteps(conversationId);
}
