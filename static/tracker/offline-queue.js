// ============================================================================
// ParentSlop – Offline Queue (IndexedDB)
// Two stores: offlineQueue (pending writes) + stateCache (persisted state)
// ============================================================================

const DB_NAME = "parentslop-offline";
const DB_VERSION = 1;

let _dbPromise = null;

function _openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("offlineQueue")) {
        db.createObjectStore("offlineQueue", { keyPath: "clientId" });
      }
      if (!db.objectStoreNames.contains("stateCache")) {
        db.createObjectStore("stateCache", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn("IndexedDB open failed:", req.error);
      _dbPromise = null;
      reject(req.error);
    };
  });
  return _dbPromise;
}

const offlineDB = {
  /** Enqueue an offline write */
  async enqueue(item) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("offlineQueue", "readwrite");
      tx.objectStore("offlineQueue").put({
        clientId: item.clientId,
        endpoint: item.endpoint,
        method: item.method,
        body: item.body,
        createdAt: new Date().toISOString(),
        status: "pending",
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /** Remove a completed/failed item from the queue */
  async dequeue(clientId) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("offlineQueue", "readwrite");
      tx.objectStore("offlineQueue").delete(clientId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /** Get all pending items, ordered by createdAt */
  async getPending() {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("offlineQueue", "readonly");
      const req = tx.objectStore("offlineQueue").getAll();
      req.onsuccess = () => {
        const items = req.result.filter((i) => i.status === "pending");
        items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  },

  /** Get count of pending items */
  async getPendingCount() {
    const items = await this.getPending();
    return items.length;
  },

  /** Cache the full app state */
  async cacheState(state) {
    try {
      const db = await _openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("stateCache", "readwrite");
        tx.objectStore("stateCache").put({
          key: "appState",
          data: JSON.parse(JSON.stringify(state)), // deep clone
          cachedAt: new Date().toISOString(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn("Failed to cache state:", e);
    }
  },

  /** Load cached state (returns null if none) */
  async getCachedState() {
    try {
      const db = await _openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("stateCache", "readonly");
        const req = tx.objectStore("stateCache").get("appState");
        req.onsuccess = () => resolve(req.result?.data || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn("Failed to load cached state:", e);
      return null;
    }
  },
};

window.offlineDB = offlineDB;
