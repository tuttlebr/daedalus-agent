const DB_NAME = 'DaedalusOfflineDB';
const DB_VERSION = 1;
const STORE_NAME = 'pendingMessages';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

export async function enqueueMessage(message: any, conversationId?: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    store.put({ id, message, conversationId, timestamp: Date.now() });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function dequeueAllMessages(): Promise<Array<{ id: string; message: any; conversationId?: string }>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getAll = store.getAll();
    getAll.onsuccess = () => {
      const items = getAll.result;
      // Clear all items
      store.clear();
      tx.oncomplete = () => { db.close(); resolve(items); };
    };
    getAll.onerror = () => { db.close(); reject(getAll.error); };
  });
}

export async function getQueueLength(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const count = store.count();
    count.onsuccess = () => { db.close(); resolve(count.result); };
    count.onerror = () => { db.close(); reject(count.error); };
  });
}
