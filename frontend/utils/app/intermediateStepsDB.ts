import { IntermediateStep } from '@/types/intermediateSteps';

// IndexedDB configuration
const DB_NAME = 'DaedalusIntermediateStepsDB';
const DB_VERSION = 1;
const STORE_NAME = 'intermediateSteps';
const CHUNK_SIZE = 50; // Reduced chunk size for better memory management
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
  eventTimestamp?: number;
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
        },
      });

      const compressedStream = stream.pipeThrough(
        new (window as any).CompressionStream('gzip'),
      );
      const reader = compressedStream.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array);
      }

      const compressed = new Uint8Array(
        chunks.reduce((acc, chunk) => acc + chunk.length, 0),
      );
      let offset = 0;
      for (const chunk of chunks) {
        compressed.set(chunk, offset);
        offset += chunk.length;
      }

      // Handle large arrays by processing in chunks to avoid stack overflow
      const CHUNK_SIZE = 8192;
      let binary = '';
      for (let i = 0; i < compressed.length; i += CHUNK_SIZE) {
        binary += String.fromCharCode.apply(
          null,
          Array.from(compressed.subarray(i, i + CHUNK_SIZE)),
        );
      }

      return btoa(binary);
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
      const compressed = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(compressed);
          controller.close();
        },
      });

      const decompressedStream = stream.pipeThrough(
        new (window as any).DecompressionStream('gzip'),
      );
      const reader = decompressedStream.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array);
      }

      const decoder = new TextDecoder();
      return (
        chunks
          .map((chunk) => decoder.decode(chunk, { stream: true }))
          .join('') + decoder.decode()
      );
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
          store.createIndex('conversationId', 'conversationId', {
            unique: false,
          });
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
    steps: IntermediateStep[],
  ): Promise<void> {
    const db = await this.ensureDB();
    // Prepare all asynchronous compression before opening a write transaction.
    // Stable step IDs make snapshots from one message idempotent without
    // replacing steps belonging to other messages in the same conversation.
    const prepared = new Map<string, StepChunk>();
    for (const step of steps) {
      const uuid = step?.payload?.UUID;
      if (!uuid) continue;
      const raw = JSON.stringify([step]);
      const encoded =
        raw.length > COMPRESSION_THRESHOLD ? await compressData(raw) : raw;
      const compressed = encoded.length < raw.length;
      const id = JSON.stringify([conversationId, 'step', uuid]);
      const chunk: StepChunk = {
        id,
        conversationId,
        chunkIndex: 0,
        steps: compressed ? (encoded as any) : [step],
        compressed,
        size: compressed ? encoded.length : raw.length,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        eventTimestamp: step.payload.event_timestamp,
      };
      const previous = prepared.get(id);
      if (
        !previous ||
        (previous.eventTimestamp ?? 0) <= (chunk.eventTimestamp ?? 0)
      )
        prepared.set(id, chunk);
    }
    if (!prepared.size) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(
          transaction.error || new Error('Step cache transaction aborted'),
        );
      const store = transaction.objectStore(STORE_NAME);
      const request = store
        .index('conversationId')
        .openCursor(IDBKeyRange.only(conversationId));
      const merged = new Map<string, StepChunk>();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          merged.set(cursor.value.id, cursor.value);
          cursor.continue();
          return;
        }
        // No await occurs in this transaction. IndexedDB serializes concurrent
        // writers, so independent message snapshots cannot overwrite each other.
        for (const [id, chunk] of prepared) {
          const previous = merged.get(id);
          if (
            previous &&
            (previous.eventTimestamp ?? 0) > (chunk.eventTimestamp ?? 0)
          )
            continue;
          merged.set(id, {
            ...chunk,
            createdAt: previous?.createdAt ?? chunk.createdAt,
          });
        }
        const ordered = [...merged.values()].sort(
          (a, b) => a.updatedAt - b.updatedAt,
        );
        let size = ordered.reduce(
          (total, chunk) =>
            total + (chunk.size ?? JSON.stringify(chunk.steps).length),
          0,
        );
        for (const chunk of ordered) {
          if (size <= MAX_SIZE_PER_CONVERSATION) break;
          size -= chunk.size ?? JSON.stringify(chunk.steps).length;
          merged.delete(chunk.id);
          store.delete(chunk.id);
        }
        for (const id of prepared.keys()) {
          const chunk = merged.get(id);
          if (chunk) store.put(chunk);
        }
      };
    });
  }

  private async readSteps(conversationId: string): Promise<IntermediateStep[]> {
    const db = await this.ensureDB();
    const chunks = await new Promise<StepChunk[]>((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const request = transaction
        .objectStore(STORE_NAME)
        .index('conversationId')
        .getAll(IDBKeyRange.only(conversationId));
      transaction.oncomplete = () => resolve(request.result as StepChunk[]);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(
          transaction.error || new Error('Step cache transaction aborted'),
        );
    });
    const byId = new Map<string, IntermediateStep>();
    // Old chunk records remain readable. Deduplicate legacy repeated snapshots
    // and count actual decoded steps, never compressed base64 characters.
    for (const chunk of chunks.sort((a, b) => a.updatedAt - b.updatedAt)) {
      try {
        const decoded: IntermediateStep[] = chunk.compressed
          ? JSON.parse(await decompressData(chunk.steps as any))
          : chunk.steps;
        for (const step of decoded) {
          const uuid = step?.payload?.UUID;
          if (!uuid) continue;
          const previous = byId.get(uuid);
          if (
            !previous ||
            previous.payload.event_timestamp <= step.payload.event_timestamp
          )
            byId.set(uuid, step);
        }
      } catch (error) {
        console.error('Failed to decode intermediate step chunk:', error);
      }
    }
    return [...byId.values()].sort(
      (a, b) => a.payload.event_timestamp - b.payload.event_timestamp,
    );
  }

  async loadSteps(
    conversationId: string,
    startIndex = 0,
    count = CHUNK_SIZE,
  ): Promise<IntermediateStep[]> {
    return (await this.readSteps(conversationId)).slice(
      startIndex,
      startIndex + count,
    );
  }

  async getStepCount(conversationId: string): Promise<number> {
    return (await this.readSteps(conversationId)).length;
  }
}

// Singleton instance
const intermediateStepsDB = new IntermediateStepsDB();

// Helper functions for easy usage
export async function saveIntermediateSteps(
  conversationId: string,
  steps: IntermediateStep[],
): Promise<void> {
  return intermediateStepsDB.saveSteps(conversationId, steps);
}

export async function loadIntermediateSteps(
  conversationId: string,
  startIndex: number = 0,
  count: number = CHUNK_SIZE,
): Promise<IntermediateStep[]> {
  return intermediateStepsDB.loadSteps(conversationId, startIndex, count);
}

export async function getIntermediateStepCount(
  conversationId: string,
): Promise<number> {
  return intermediateStepsDB.getStepCount(conversationId);
}
