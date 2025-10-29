import { IntermediateStep } from '@/types/intermediateSteps';

// IndexedDB configuration
const DB_NAME = 'DaedalusIntermediateStepsDB';
const DB_VERSION = 1;
const STORE_NAME = 'intermediateSteps';
const CHUNK_SIZE = 50; // Reduced chunk size for better memory management
const MAX_AGE_HOURS = 12; // Reduced from 24 to 12 hours
const MAX_SIZE_PER_CONVERSATION = 10 * 1024 * 1024; // 10MB max per conversation
const COMPRESSION_THRESHOLD = 1024; // Compress steps larger than 1KB

interface StepChunk {
  id: string;
  conversationId: string;
  chunkIndex: number;
  steps: IntermediateStep[];
  createdAt: number;
  updatedAt: number;
  compressed?: boolean;
  size?: number;
}

// Simple compression utilities (using browser's CompressionStream API if available)
async function compressData(data: string): Promise<string> {
  if ('CompressionStream' in window) {
    try {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(data));
          controller.close();
        }
      });

      const compressedStream = stream.pipeThrough(new (window as any).CompressionStream('gzip'));
      const reader = compressedStream.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array);
      }

      const compressed = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        compressed.set(chunk, offset);
        offset += chunk.length;
      }

      return btoa(String.fromCharCode.apply(null, Array.from(compressed)));
    } catch (error) {
      console.error('Compression failed:', error);
      return data;
    }
  }
  return data;
}

async function decompressData(data: string): Promise<string> {
  if ('DecompressionStream' in window) {
    try {
      const compressed = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(compressed);
          controller.close();
        }
      });

      const decompressedStream = stream.pipeThrough(new (window as any).DecompressionStream('gzip'));
      const reader = decompressedStream.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array);
      }

      const decoder = new TextDecoder();
      return chunks.map(chunk => decoder.decode(chunk)).join('');
    } catch (error) {
      console.error('Decompression failed:', error);
      return data;
    }
  }
  return data;
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

    // Check current size for this conversation
    const currentSize = await this.getConversationSize(conversationId);

    // Estimate new data size
    const newDataSize = JSON.stringify(steps).length;

    // If adding this would exceed limit, clean up old chunks
    if (currentSize + newDataSize > MAX_SIZE_PER_CONVERSATION) {
      await this.cleanupOldestChunks(conversationId, newDataSize);
    }

    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    // Split steps into chunks
    const chunks: StepChunk[] = [];
    for (let i = 0; i < steps.length; i += CHUNK_SIZE) {
      const chunkSteps = steps.slice(i, i + CHUNK_SIZE);
      const chunkData = JSON.stringify(chunkSteps);
      const chunkSize = chunkData.length;

      // Compress if chunk is large
      let processedSteps = chunkSteps;
      let compressed = false;
      let compressedSize = chunkSize;

      if (chunkSize > COMPRESSION_THRESHOLD) {
        try {
          const compressedData = await compressData(chunkData);
          // Only use compression if it actually reduces size
          if (compressedData.length < chunkData.length) {
            processedSteps = compressedData as any;
            compressed = true;
            compressedSize = compressedData.length;
          }
        } catch (error) {
          console.error('Failed to compress chunk:', error);
        }
      }

      const chunk: StepChunk = {
        id: `${conversationId}_chunk_${Math.floor(i / CHUNK_SIZE)}_${Date.now()}`,
        conversationId,
        chunkIndex: Math.floor(i / CHUNK_SIZE),
        steps: processedSteps,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        compressed,
        size: compressed ? compressedSize : chunkSize
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

    return new Promise(async (resolve, reject) => {
      const steps: IntermediateStep[] = [];
      const chunks: StepChunk[] = [];
      const request = index.openCursor(IDBKeyRange.only(conversationId));

      request.onsuccess = async (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          chunks.push(cursor.value as StepChunk);
          cursor.continue();
        } else {
          // Process all chunks
          for (const chunk of chunks.sort((a, b) => a.chunkIndex - b.chunkIndex)) {
            if (chunk.compressed) {
              try {
                const decompressed = await decompressData(chunk.steps as any);
                const decompressedSteps = JSON.parse(decompressed);
                steps.push(...decompressedSteps);
              } catch (error) {
                console.error('Failed to decompress chunk:', error);
                // Skip corrupted chunk
              }
            } else {
              steps.push(...(chunk.steps as IntermediateStep[]));
            }
          }

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

  async getConversationSize(conversationId: string): Promise<number> {
    const db = await this.ensureDB();
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('conversationId');

    return new Promise((resolve, reject) => {
      let totalSize = 0;
      const request = index.openCursor(IDBKeyRange.only(conversationId));

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          const chunk = cursor.value as StepChunk;
          totalSize += chunk.size || JSON.stringify(chunk.steps).length;
          cursor.continue();
        } else {
          resolve(totalSize);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  async cleanupOldestChunks(conversationId: string, requiredSpace: number): Promise<void> {
    const db = await this.ensureDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('conversationId');

    const chunks: StepChunk[] = [];

    return new Promise((resolve, reject) => {
      // First, collect all chunks
      const request = index.openCursor(IDBKeyRange.only(conversationId));

      request.onsuccess = async (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          chunks.push(cursor.value as StepChunk);
          cursor.continue();
        } else {
          // Sort by creation date (oldest first)
          chunks.sort((a, b) => a.createdAt - b.createdAt);

          let spaceFreed = 0;
          for (const chunk of chunks) {
            if (spaceFreed >= requiredSpace) break;

            spaceFreed += chunk.size || JSON.stringify(chunk.steps).length;
            await new Promise<void>((deleteResolve, deleteReject) => {
              const deleteRequest = store.delete(chunk.id);
              deleteRequest.onsuccess = () => deleteResolve();
              deleteRequest.onerror = () => deleteReject(deleteRequest.error);
            });
          }

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
