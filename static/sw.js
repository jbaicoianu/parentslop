const CACHE_VERSION = 'parentslop-v12';
const STATIC_ASSETS = [
  '/',
  '/index.html',
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
