import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Minimal in-memory IndexedDB mock for testing the offline queue.
 *
 * This avoids depending on `fake-indexeddb` while exercising the real
 * enqueueMessage / dequeueAllMessages / getQueueLength logic.
 */

// ---- In-memory IDB mock ----

class MockIDBRequest {
  result: any = undefined;
  error: any = null;
  onsuccess: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;

  _resolve(value: any) {
    this.result = value;
    this.onsuccess?.({ target: this });
  }

  _reject(err: any) {
    this.error = err;
    this.onerror?.({ target: this });
  }
}

class MockObjectStore {
  private data = new Map<string, any>();

  put(value: any) {
    const req = new MockIDBRequest();
    this.data.set(value.id, value);
    queueMicrotask(() => req._resolve(undefined));
    return req;
  }

  getAll() {
    const req = new MockIDBRequest();
    queueMicrotask(() => req._resolve(Array.from(this.data.values())));
    return req;
  }

  clear() {
    const req = new MockIDBRequest();
    this.data.clear();
    queueMicrotask(() => req._resolve(undefined));
    return req;
  }

  count() {
    const req = new MockIDBRequest();
    queueMicrotask(() => req._resolve(this.data.size));
    return req;
  }
}

class MockTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: any = null;
  private store: MockObjectStore;

  constructor(store: MockObjectStore) {
    this.store = store;
    // Fire oncomplete asynchronously after all microtasks from store ops settle
    queueMicrotask(() => {
      queueMicrotask(() => {
        this.oncomplete?.();
      });
    });
  }

  objectStore(_name: string) {
    return this.store;
  }
}

class MockIDBDatabase {
  objectStoreNames = { contains: (_name: string) => true };
  private store = new MockObjectStore();

  transaction(_storeName: string, _mode?: string) {
    return new MockTransaction(this.store);
  }

  createObjectStore(_name: string, _opts: any) {
    return this.store;
  }

  close() {}
}

function createMockIndexedDB() {
  const db = new MockIDBDatabase();

  return {
    open(_name: string, _version?: number) {
      const req = new MockIDBRequest();
      queueMicrotask(() => {
        (req as any).result = db;
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
}

// ---- Install mock ----

const mockIDB = createMockIndexedDB();
vi.stubGlobal('indexedDB', mockIDB);

// We must import the module AFTER the mock is in place
// so that openDB() sees our mock `indexedDB` global.
import { enqueueMessage, dequeueAllMessages, getQueueLength } from '@/utils/app/offlineQueue';

describe('offlineQueue', () => {
  // Each test suite gets a fresh IDB mock to avoid state leaking between tests.
  beforeEach(() => {
    const freshMockIDB = createMockIndexedDB();
    vi.stubGlobal('indexedDB', freshMockIDB);
  });

  describe('enqueueMessage', () => {
    it('adds a message without throwing', async () => {
      await expect(enqueueMessage({ text: 'hello' })).resolves.toBeUndefined();
    });

    it('accepts an optional conversationId', async () => {
      await expect(enqueueMessage({ text: 'hello' }, 'conv-123')).resolves.toBeUndefined();
    });
  });

  describe('getQueueLength', () => {
    it('returns 0 for an empty queue', async () => {
      const length = await getQueueLength();
      expect(length).toBe(0);
    });
  });

  describe('dequeueAllMessages', () => {
    it('returns an empty array for an empty queue', async () => {
      const messages = await dequeueAllMessages();
      expect(messages).toEqual([]);
    });
  });

  describe('enqueue then dequeue round-trip', () => {
    it('returns enqueued messages with id and timestamp', async () => {
      await enqueueMessage({ text: 'msg1' }, 'conv-1');
      await enqueueMessage({ text: 'msg2' });

      const length = await getQueueLength();
      expect(length).toBe(2);

      const messages = await dequeueAllMessages();
      expect(messages).toHaveLength(2);

      // Each message should have an id, the original message, and a timestamp
      for (const msg of messages) {
        expect(msg).toHaveProperty('id');
        expect(msg.id).toMatch(/^msg-/);
        expect(msg).toHaveProperty('message');
        expect(msg).toHaveProperty('timestamp');
        expect(typeof msg.timestamp).toBe('number');
      }

      expect(messages[0].message).toEqual({ text: 'msg1' });
      expect(messages[0].conversationId).toBe('conv-1');
      expect(messages[1].message).toEqual({ text: 'msg2' });
    });

    it('clears the store after dequeue', async () => {
      await enqueueMessage({ text: 'msg1' });
      await dequeueAllMessages();

      const length = await getQueueLength();
      expect(length).toBe(0);

      const messages = await dequeueAllMessages();
      expect(messages).toEqual([]);
    });
  });

  describe('module exports', () => {
    it('exports enqueueMessage as a function', () => {
      expect(typeof enqueueMessage).toBe('function');
    });

    it('exports dequeueAllMessages as a function', () => {
      expect(typeof dequeueAllMessages).toBe('function');
    });

    it('exports getQueueLength as a function', () => {
      expect(typeof getQueueLength).toBe('function');
    });
  });
});
