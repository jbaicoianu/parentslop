const CACHE_VERSION = 'parentslop-v13';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/tracker/offline-queue.js',
  '/tracker/core.js',
  '/tracker/sfx.js',
  '/tracker/components/ps-auth-screen.js',
  '/tracker/components/ps-setup-wizard.js',
  '/tracker/components/ps-nav-bar.js',
  '/tracker/components/ps-balance-bar.js',
  '/tracker/components/ps-dashboard.js',
  '/tracker/components/ps-task-list.js',
  '/tracker/components/ps-timer-tray.js',
  '/tracker/components/ps-streak-badge.js',
  '/tracker/components/ps-reward-shop.js',
  '/tracker/components/ps-admin-tasks.js',
  '/tracker/components/ps-admin-shop.js',
  '/tracker/components/ps-admin-currencies.js',
  '/tracker/components/ps-admin-approvals.js',
  '/tracker/components/ps-admin-users.js',
  '/tracker/components/ps-admin-log.js',
  '/tracker/components/ps-admin-feedback.js',
  '/tracker/components/ps-admin-security.js',
  '/tracker/components/ps-history.js',
  '/tracker/components/ps-feedback-fab.js',
];

// Pre-cache static assets on install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Clean up old caches on activate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Background sync: replay offline queue when connectivity returns
self.addEventListener('sync', (event) => {
  if (event.tag === 'replay-offline-queue') {
    event.waitUntil(replayFromSW());
  }
});

async function replayFromSW() {
  const DB_NAME = 'parentslop-offline';
  const DB_VERSION = 1;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('offlineQueue')) {
          db.createObjectStore('offlineQueue', { keyPath: 'clientId' });
        }
        if (!db.objectStoreNames.contains('stateCache')) {
          db.createObjectStore('stateCache', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  try {
    const db = await openDB();

    const items = await new Promise((resolve, reject) => {
      const tx = db.transaction('offlineQueue', 'readonly');
      const req = tx.objectStore('offlineQueue').getAll();
      req.onsuccess = () => resolve(req.result.filter(i => i.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      req.onerror = () => reject(req.error);
    });

    for (const item of items) {
      try {
        const res = await fetch(item.endpoint, {
          method: item.method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.body),
        });
        if (res.ok || (res.status >= 400 && res.status < 500)) {
          // Success or client error (won't retry) — dequeue
          await new Promise((resolve, reject) => {
            const tx = db.transaction('offlineQueue', 'readwrite');
            tx.objectStore('offlineQueue').delete(item.clientId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        } else {
          // Server error — stop replaying, let sync retry later
          break;
        }
      } catch {
        // Network error — stop replaying
        break;
      }
    }

    // Notify open clients to refresh state
    const clients = await self.clients.matchAll();
    for (const client of clients) {
      client.postMessage({ type: 'offline-queue-replayed' });
    }
  } catch (e) {
    console.warn('SW: replay failed', e);
  }
}

// Fetch strategy: network-first for API, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API requests: network only, let failures propagate (TrackerStore handles them)
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Static assets: network-first, fall back to cache when offline
  event.respondWith(
    fetch(event.request).then((response) => {
      // Update cache with fresh response
      if (response.ok && url.origin === self.location.origin) {
        const clone = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
